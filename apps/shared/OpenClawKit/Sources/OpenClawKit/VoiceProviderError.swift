import Foundation

/// Unified error type for the non-realtime voice providers (TTS + transcription).
///
/// Realtime sessions surface these through their event stream as well, so the error
/// shape is consistent regardless of capability.
public struct VoiceProviderError: Error, Sendable, Equatable {
    public enum Code: String, Sendable, Equatable {
        case missingCredentials
        case invalidConfig
        case network
        case server
        case badResponse
        case canceled
        case timeout
    }

    public let code: Code
    public let httpStatus: Int?
    public let providerRequestId: String?
    public let message: String

    /// Optional underlying transport error for debugging. Compared by identity equality
    /// in `Equatable`, so tests should use non-nil `underlying` values sparingly.
    public let underlying: (any Error & Sendable)?

    public init(
        code: Code,
        httpStatus: Int? = nil,
        providerRequestId: String? = nil,
        message: String,
        underlying: (any Error & Sendable)? = nil
    ) {
        self.code = code
        self.httpStatus = httpStatus
        self.providerRequestId = providerRequestId
        self.message = message
        self.underlying = underlying
    }

    public static func == (lhs: VoiceProviderError, rhs: VoiceProviderError) -> Bool {
        lhs.code == rhs.code
            && lhs.httpStatus == rhs.httpStatus
            && lhs.providerRequestId == rhs.providerRequestId
            && lhs.message == rhs.message
    }
}

extension VoiceProviderError: LocalizedError {
    public var errorDescription: String? {
        if let httpStatus {
            return "voice \(self.code.rawValue) (\(httpStatus)): \(self.message)"
        }
        return "voice \(self.code.rawValue): \(self.message)"
    }
}
