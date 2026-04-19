import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

@Suite struct GatewayRealtimeCodecTests {
    // MARK: Client encode

    @Test func inputAudioAppendEncodesBase64Verbatim() throws {
        let text = try GatewayRealtimeCodec.encode(.inputAudioAppend(base64Pcm16: "AAAA"))
        let decoded = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        #expect(decoded?["type"] as? String == "input_audio_buffer.append")
        #expect(decoded?["audio"] as? String == "AAAA")
    }

    @Test func sessionEndUsesWireReasonStrings() throws {
        let text = try GatewayRealtimeCodec.encode(.sessionEnd(reason: .appBackground))
        let decoded = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        #expect(decoded?["type"] as? String == "session.end")
        #expect(decoded?["reason"] as? String == "app_background")
    }

    @Test func pingCarriesTheSuppliedTimestamp() throws {
        let text = try GatewayRealtimeCodec.encode(.ping(ts: 1_234_567))
        let decoded = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        #expect(decoded?["type"] as? String == "ping")
        // JSON numbers decode as NSNumber-backed Double or Int depending on size.
        let ts = decoded?["ts"] as? Int64 ?? Int64((decoded?["ts"] as? Int) ?? 0)
        #expect(ts == 1_234_567)
    }

    // MARK: Server decode

    @Test func sessionReadyDecodesFullAudioDescriptor() throws {
        let raw = """
        {"type":"session.ready","voiceRunId":"run-1","sessionKey":"agent:main:main","audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}
        """
        let event = try GatewayRealtimeCodec.decode(raw)
        #expect(event == .sessionReady(
            voiceRunId: "run-1",
            sessionKey: "agent:main:main",
            audio: GatewayRealtimeAudio(sampleRateHz: 24_000, format: "pcm16", channels: 1)))
    }

    @Test func toolCallFinishedToleratesIntegerDuration() throws {
        // JSON can emit `durationMs` as either an integer or a double; the
        // codec coerces both to Double.
        let raw = """
        {"type":"response.tool_call.finished","callId":"c1","name":"lookup","durationMs":42,"ok":true}
        """
        let event = try GatewayRealtimeCodec.decode(raw)
        #expect(event == .toolCallFinished(callId: "c1", name: "lookup", durationMs: 42.0, ok: true))
    }

    @Test func closedFrameSurfacesCloseCodeVerbatim() throws {
        let raw = """
        {"type":"closed","reason":"replaced_by_newer","code":4010}
        """
        let event = try GatewayRealtimeCodec.decode(raw)
        #expect(event == .closed(reason: "replaced_by_newer", code: 4010))
    }

    @Test func unknownServerEventTypeIsDroppedSilently() throws {
        let raw = """
        {"type":"future.event.we.do.not.know","payload":{}}
        """
        let event = try GatewayRealtimeCodec.decode(raw)
        #expect(event == nil)
    }

    @Test func notUtf8InputThrows() {
        // `String` is always UTF-8 in Swift, but we simulate a broken
        // decode by passing a non-object JSON literal.
        #expect(throws: GatewayRealtimeTransportError.self) {
            _ = try GatewayRealtimeCodec.decode("42")
        }
    }

    @Test func roundTripThroughEncodeAndBackIsLossless() throws {
        // Round-trip every client event to prove ordering and shape are
        // stable. We re-parse the encoded JSON rather than doing string
        // compare because `JSONSerialization` keys ordering can vary.
        let cases: [GatewayRealtimeClientEvent] = [
            .inputAudioAppend(base64Pcm16: "ZGF0YQ=="),
            .inputAudioCommit,
            .responseCancel,
            .sessionEnd(reason: .userCancel),
            .sessionEnd(reason: .appBackground),
            .ping(ts: 42),
        ]
        for event in cases {
            let text = try GatewayRealtimeCodec.encode(event)
            let parsed = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            switch event {
            case .inputAudioAppend(let b64):
                #expect(parsed?["type"] as? String == "input_audio_buffer.append")
                #expect(parsed?["audio"] as? String == b64)
            case .inputAudioCommit:
                #expect(parsed?["type"] as? String == "input_audio_buffer.commit")
            case .responseCancel:
                #expect(parsed?["type"] as? String == "response.cancel")
            case .sessionEnd(let reason):
                #expect(parsed?["type"] as? String == "session.end")
                #expect(parsed?["reason"] as? String == reason.rawValue)
            case .ping(let ts):
                #expect(parsed?["type"] as? String == "ping")
                let parsedTs = parsed?["ts"] as? Int64 ?? Int64((parsed?["ts"] as? Int) ?? 0)
                #expect(parsedTs == ts)
            }
        }
    }
}

@Suite struct GatewayRealtimeCloseCodeTests {
    @Test func replacedByNewerTerminates() {
        #expect(GatewayRealtimeCloseCode.replacedByNewer.reconnectDecision == .terminate)
    }

    @Test func sessionEndedTerminates() {
        #expect(GatewayRealtimeCloseCode.sessionEnded.reconnectDecision == .terminate)
    }

    @Test func ticketExpiredReconnectsWithFreshTicket() {
        #expect(
            GatewayRealtimeCloseCode.ticketExpired.reconnectDecision
                == .reconnectWithFreshTicket)
    }

    @Test func bridgeErrorAndProviderClosedReconnect() {
        #expect(
            GatewayRealtimeCloseCode.bridgeError.reconnectDecision
                == .reconnectWithFreshTicket)
        #expect(
            GatewayRealtimeCloseCode.providerClosed.reconnectDecision
                == .reconnectWithFreshTicket)
    }

    @Test func allCodesAreInTheApplicationPrivateRange() {
        for code in GatewayRealtimeCloseCode.allCases {
            #expect(code.rawValue >= 4000)
            #expect(code.rawValue < 5000)
        }
    }

    @Test func pinnedCodeValuesMatchGatewayProtocolTs() {
        // These values are hard-coded here because a mismatch with
        // `src/gateway/talk-realtime/protocol.ts` would silently break
        // the reconnect policy. Keep this test in sync with
        // TALK_REALTIME_CLOSE.
        #expect(GatewayRealtimeCloseCode.ticketInvalid.rawValue == 4001)
        #expect(GatewayRealtimeCloseCode.ticketExpired.rawValue == 4002)
        #expect(GatewayRealtimeCloseCode.ticketConsumed.rawValue == 4003)
        #expect(GatewayRealtimeCloseCode.replacedByNewer.rawValue == 4010)
        #expect(GatewayRealtimeCloseCode.bridgeError.rawValue == 4011)
        #expect(GatewayRealtimeCloseCode.sessionEnded.rawValue == 4020)
        #expect(GatewayRealtimeCloseCode.providerClosed.rawValue == 4030)
    }
}

@Suite struct GatewayRealtimeTicketIssuerTests {
    @Test func issuerDecodesAFullTicketResult() async throws {
        let sample = """
        {
          "voiceRunId": "run-abc",
          "sessionKey": "agent:main:main",
          "ticket": "tk-xyz",
          "wsPath": "/talk/realtime",
          "expiresAtMs": 1700000120000,
          "audio": { "sampleRateHz": 24000, "format": "pcm16", "channels": 1 }
        }
        """
        let issuer = GatewayRealtimeTicketIssuer { method, params in
            #expect(method == "talk.realtime.start")
            _ = params
            return Data(sample.utf8)
        }
        let ticket = try await issuer.issue(
            agentId: "main", providerId: "openai", voiceId: "alloy")
        #expect(ticket.voiceRunId == "run-abc")
        #expect(ticket.sessionKey == "agent:main:main")
        #expect(ticket.ticket == "tk-xyz")
        #expect(ticket.wsPath == "/talk/realtime")
        #expect(ticket.expiresAtMs == 1_700_000_120_000)
        #expect(ticket.audio.sampleRateHz == 24_000)
    }

    @Test func issuerOmitsEmptyParams() async throws {
        final class Box: @unchecked Sendable { var captured: [String: AnyCodable]? }
        let box = Box()
        let sample = """
        {"voiceRunId":"r","sessionKey":"s","ticket":"t","wsPath":"/talk/realtime","expiresAtMs":1,"audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}
        """
        let issuer = GatewayRealtimeTicketIssuer { method, params in
            _ = method
            box.captured = params
            return Data(sample.utf8)
        }
        _ = try await issuer.issue(agentId: nil, providerId: nil, voiceId: nil)
        #expect(box.captured == nil)
    }

    @Test func issuerSurfacesAMalformedResponseAsTransportError() async throws {
        let issuer = GatewayRealtimeTicketIssuer { _, _ in
            Data("{ not json ".utf8)
        }
        await #expect(throws: GatewayRealtimeTransportError.self) {
            _ = try await issuer.issue(agentId: "main", providerId: nil, voiceId: nil)
        }
    }
}
