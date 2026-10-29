import Darwin
import Foundation
import Network

public struct CoordinatorAddress: Sendable, Equatable {
  public let host: String
  public let port: UInt16

  // Numeric tailnet addresses only. No DNS rebinding or unencrypted LAN fallback.
  public init(host: String, port: UInt16 = 43187) throws {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    let octets = parts.compactMap { UInt8($0) }
    guard octets.count == 4, parts.map(String.init) == octets.map(String.init),
      octets[0] == 100, (64...127).contains(octets[1]), port > 0
    else { throw ConnectionError.invalidAddress }
    self.host = host
    self.port = port
  }
}

public enum ConnectionError: Error, LocalizedError, Sendable {
  case invalidAddress, vpnUnavailable, frameTooLarge, incompleteFrame, closed, timedOut
  public var errorDescription: String? {
    switch self {
    case .vpnUnavailable:
      "Connect Tailscale first. No active point-to-point interface has a Tailscale IPv4 address."
    case .invalidAddress: "Enter the coordinator’s numeric Tailscale IPv4 address and port."
    case .frameTooLarge: "The coordinator sent a frame larger than 4 MiB."
    case .incompleteFrame:
      "The connection ended during a message. Reconnect to recover saved history."
    case .closed: "The coordinator disconnected. Saved work remains on the coordinator."
    case .timedOut: "The coordinator did not respond. Check Tailscale and the coordinator service."
    }
  }
}

/// One owner, one reader. Cancellation closes the underlying socket, not just its waiter.
actor LineConnection {
  private let connection: NWConnection
  private var buffer = Data()
  private var ended = false
  static let maximumFrameBytes = 4 * 1024 * 1024

  init(address: CoordinatorAddress) throws {
    guard let port = NWEndpoint.Port(rawValue: address.port) else {
      throw ConnectionError.invalidAddress
    }
    let tcp = NWProtocolTCP.Options()
    tcp.connectionTimeout = 15
    tcp.enableKeepalive = true
    tcp.keepaliveIdle = 30
    tcp.keepaliveInterval = 10
    tcp.keepaliveCount = 3
    let parameters = NWParameters(tls: nil, tcp: tcp)
    // Binding the tunnel's own address fails closed when the VPN disappears.
    // Merely recognizing 100.64/10 is not enough on a carrier-grade NAT LAN.
    parameters.requiredLocalEndpoint = .hostPort(host: .init(try Self.tunnelAddress()), port: .any)
    connection = NWConnection(host: .init(address.host), port: port, using: parameters)
    connection.start(queue: .global(qos: .userInitiated))
  }

  // Tests exercise the real reader/writer over a local Network.framework listener.
  init(connection: NWConnection) {
    self.connection = connection
    connection.start(queue: .global(qos: .userInitiated))
  }

  private static func tunnelAddress() throws -> String {
    var first: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&first) == 0 else { throw ConnectionError.vpnUnavailable }
    defer { freeifaddrs(first) }
    var cursor = first
    while let interface = cursor {
      defer { cursor = interface.pointee.ifa_next }
      let flags = interface.pointee.ifa_flags
      guard flags & UInt32(IFF_UP) != 0, flags & UInt32(IFF_POINTOPOINT) != 0,
        let address = interface.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET)
      else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard
        getnameinfo(
          address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0,
          NI_NUMERICHOST) == 0
      else { continue }
      let bytes = host.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }
      let value = String(decoding: bytes, as: UTF8.self)
      if (try? CoordinatorAddress(host: value)) != nil { return value }
    }
    throw ConnectionError.vpnUnavailable
  }
  func close() {
    ended = true
    connection.cancel()
  }

  func send(_ request: NativeRequest) async throws {
    let command = NativeCommand.native(.init(request: request))
    var bytes = try JSONEncoder().encode(command)
    guard bytes.count <= Self.maximumFrameBytes else { throw ConnectionError.frameTooLarge }
    bytes.append(10)
    let connection = connection
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, any Error>) in
        connection.send(
          content: bytes,
          completion: .contentProcessed { error in
            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
          })
      }
    } onCancel: {
      connection.cancel()
    }
  }

  func next() async throws -> NativeEvent {
    while true {
      try Task.checkCancellation()
      if let newline = buffer.firstIndex(of: 10) {
        guard newline <= Self.maximumFrameBytes else { throw ConnectionError.frameTooLarge }
        let frame = buffer.prefix(upTo: newline)
        let event = try JSONDecoder().decode(NativeEvent.self, from: frame)
        buffer.removeSubrange(...newline)
        return event
      }
      guard buffer.count <= Self.maximumFrameBytes else { throw ConnectionError.frameTooLarge }
      if ended { throw buffer.isEmpty ? ConnectionError.closed : ConnectionError.incompleteFrame }
      let connection = connection
      let (data, complete) = try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation {
          (continuation: CheckedContinuation<(Data, Bool), any Error>) in
          connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
            data, _, complete, error in
            if let error {
              continuation.resume(throwing: error)
            } else {
              continuation.resume(returning: (data ?? Data(), complete))
            }
          }
        }
      } onCancel: {
        connection.cancel()
      }
      buffer.append(data)
      ended = complete
    }
  }
}
