import Foundation
import os

/// Narrow seam so tests can stub the WebSocket without touching the network.
///
/// Implementations MUST be safe to call from an `actor` — no shared-mutable state
/// outside their own isolation.
public protocol RealtimeWebSocket: Sendable {
    /// Open the WebSocket. Returns once the handshake has succeeded. Throws a
    /// `RealtimeWebSocketError` on failure; the caller decides whether the failure
    /// is transient (retry/fallback) or terminal.
    func connect() async throws

    /// Send a UTF-8 JSON frame. The transport MAY buffer and coalesce if it is
    /// already shutting down.
    func sendText(_ text: String) async throws

    /// Receive the next frame. Returns `nil` when the peer closed cleanly.
    func receive() async throws -> RealtimeWebSocketFrame?

    /// Close the WebSocket with the given `code`. Must be idempotent.
    func close(code: RealtimeWebSocketCloseCode) async
}

public enum RealtimeWebSocketFrame: Sendable, Equatable {
    case text(String)
    case data(Data)
}

public enum RealtimeWebSocketCloseCode: Int, Sendable, Equatable {
    case normal = 1_000
    case goingAway = 1_001
    case abnormal = 1_006
    case serverError = 1_011
}

public struct RealtimeWebSocketError: Error, Sendable, Equatable {
    public let kind: Kind
    public let message: String

    public enum Kind: String, Sendable, Equatable {
        case handshakeFailed
        case closedAbnormally
        case serverError
        case rateLimited
        case serviceUnavailable
        case timeout
        case transport
    }

    public init(kind: Kind, message: String) {
        self.kind = kind
        self.message = message
    }

    /// Classify this error as a transient failure for fallback/retry decisions, or
    /// `nil` when it is terminal.
    public var transientFailure: RealtimeTransientFailure? {
        switch self.kind {
        case .closedAbnormally: return .abnormalClose1006
        case .serverError: return .serverErrorClose1011
        case .rateLimited: return .rateLimited
        case .serviceUnavailable: return .serviceUnavailable
        case .timeout: return .timeout
        case .transport: return .transport
        case .handshakeFailed: return .transport
        }
    }
}

/// `URLSessionWebSocketTask`-backed implementation. Kept small: it only reshapes
/// the Apple API into `RealtimeWebSocket` and classifies errors for the session
/// actor.
///
/// Thread-safety: the public API is always called serially from the owning
/// session actor, but `URLSessionWebSocketTask` delegate callbacks can fire on
/// arbitrary queues, so we guard the mutable state with `OSAllocatedUnfairLock`
/// (async-context-safe unlike `NSLock`).
public final class URLSessionRealtimeWebSocket: RealtimeWebSocket, @unchecked Sendable {
    private struct State {
        var task: URLSessionWebSocketTask?
        var isClosed: Bool = false
    }

    private let url: URL
    private let headers: [String: String]
    private let session: URLSession
    private let state = OSAllocatedUnfairLock(initialState: State())

    public init(url: URL, headers: [String: String], session: URLSession = .shared) {
        self.url = url
        self.headers = headers
        self.session = session
    }

    public func connect() async throws {
        var request = URLRequest(url: self.url)
        for (field, value) in self.headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        let task = self.session.webSocketTask(with: request)
        self.state.withLock { state in
            state.task = task
        }
        task.resume()
        // URLSessionWebSocketTask does not expose a direct handshake-success callback
        // on all OS versions, so failures surface on the first `receive()` or first
        // `send()`. The session actor treats those as transient.
    }

    public func sendText(_ text: String) async throws {
        let task = self.state.withLock { $0.task }
        guard let task else {
            throw RealtimeWebSocketError(kind: .transport, message: "socket not opened")
        }
        do {
            try await task.send(.string(text))
        } catch {
            throw Self.classify(error)
        }
    }

    public func receive() async throws -> RealtimeWebSocketFrame? {
        let task = self.state.withLock { $0.task }
        guard let task else { return nil }
        do {
            let message = try await task.receive()
            switch message {
            case .string(let text): return .text(text)
            case .data(let data): return .data(data)
            @unknown default: return nil
            }
        } catch {
            if self.state.withLock({ $0.isClosed }) {
                return nil
            }
            throw Self.classify(error)
        }
    }

    public func close(code: RealtimeWebSocketCloseCode) async {
        let (task, alreadyClosed) = self.state.withLock { state -> (URLSessionWebSocketTask?, Bool) in
            let already = state.isClosed
            state.isClosed = true
            return (state.task, already)
        }
        guard !alreadyClosed, let task else { return }
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code.rawValue) ?? .normalClosure
        task.cancel(with: closeCode, reason: nil)
    }

    static func classify(_ error: Error) -> RealtimeWebSocketError {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorTimedOut:
                return RealtimeWebSocketError(kind: .timeout, message: nsError.localizedDescription)
            case NSURLErrorNetworkConnectionLost,
                 NSURLErrorNotConnectedToInternet,
                 NSURLErrorCannotConnectToHost,
                 NSURLErrorCannotFindHost,
                 NSURLErrorDNSLookupFailed:
                return RealtimeWebSocketError(kind: .transport, message: nsError.localizedDescription)
            default:
                break
            }
        }
        // URLSessionWebSocketTask surfaces remote abnormal close as
        // `NSPOSIXErrorDomain code 57` (socket not connected) on iOS — treat as
        // abnormal close for fallback purposes.
        if nsError.domain == "NSPOSIXErrorDomain" {
            return RealtimeWebSocketError(kind: .closedAbnormally, message: nsError.localizedDescription)
        }
        return RealtimeWebSocketError(kind: .transport, message: error.localizedDescription)
    }
}

