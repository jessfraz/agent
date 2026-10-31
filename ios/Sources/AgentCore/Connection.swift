import Darwin
import Foundation
import Network

public struct CoordinatorAddress: Sendable, Equatable {
  public let host: String
  public let port: UInt16

  // Full MagicDNS names are resolved and pinned to a validated tailnet address per connection.
  public init(host: String, port: UInt16 = 43187) throws {
    let host =
      host.lowercased().hasSuffix(".") ? String(host.dropLast()).lowercased() : host.lowercased()
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    let magicDNS =
      host.hasSuffix(".ts.net") && labels.count >= 4 && host.utf8.count <= 253
      && labels.allSatisfy { label in
        !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-"
          && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
      }
    guard port > 0, Self.isTailnetIP(host) || magicDNS else { throw ConnectionError.invalidAddress }
    self.host = host
    self.port = port
  }
  static func isTailnetIP(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    let octets = parts.compactMap { UInt8($0) }
    return octets.count == 4 && parts.map(String.init) == octets.map(String.init)
      && octets[0] == 100 && (64...127).contains(octets[1])
  }

  func resolvedHost(using resolve: (String) throws -> [String] = Self.resolve) throws -> String {
    if Self.isTailnetIP(host) { return host }
    let addresses = try resolve(host)
    guard let first = addresses.first, addresses.allSatisfy(Self.isTailnetIP) else {
      throw ConnectionError.invalidAddress
    }
    return first
  }
  private static func resolve(_ host: String) throws -> [String] {
    var hints = addrinfo()
    hints.ai_family = AF_INET
    hints.ai_socktype = SOCK_STREAM
    hints.ai_protocol = IPPROTO_TCP
    var first: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, nil, &hints, &first) == 0 else { throw ConnectionError.dnsUnavailable }
    defer { freeaddrinfo(first) }
    var addresses: [String] = []
    var cursor = first
    while let item = cursor {
      defer { cursor = item.pointee.ai_next }
      var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard
        getnameinfo(
          item.pointee.ai_addr, item.pointee.ai_addrlen, &name, socklen_t(name.count), nil, 0,
          NI_NUMERICHOST) == 0
      else { throw ConnectionError.dnsUnavailable }
      addresses.append(
        String(
          decoding: name.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self))
    }
    return addresses
  }
}

public enum ConnectionError: Error, LocalizedError, Sendable {
  case invalidAddress, dnsUnavailable, vpnUnavailable, frameTooLarge, incompleteFrame, closed,
    timedOut
  public var errorDescription: String? {
    switch self {
    case .vpnUnavailable:
      "Connect Tailscale first. No active point-to-point interface has a Tailscale IPv4 address."
    case .invalidAddress: "Enter a Tailscale IPv4 address or full MagicDNS name and port."
    case .dnsUnavailable:
      "The coordinator name could not be resolved. Check Tailscale’s DNS settings."
    case .frameTooLarge: "The coordinator sent a frame larger than 4 MiB."
    case .incompleteFrame:
      "The connection ended during a message. Reconnect to recover saved history."
    case .closed: "The coordinator disconnected. Saved work remains on the coordinator."
    case .timedOut: "The coordinator did not respond. Check Tailscale and the coordinator service."
    }
  }
  static func describe(_ error: any Error) -> String {
    if let network = error as? NWError, case .posix(.ECONNRESET) = network {
      return "The coordinator closed the connection. This device may need access."
    }
    return error.localizedDescription
  }
  static func shouldReconnect(after error: any Error) -> Bool {
    if let error = error as? ConnectionError {
      switch error {
      case .closed, .timedOut, .incompleteFrame, .dnsUnavailable, .vpnUnavailable: return true
      case .invalidAddress, .frameTooLarge: return false
      }
    }
    if let error = error as? NWError {
      switch error {
      case .posix(.EACCES), .posix(.EPERM), .posix(.EINVAL), .tls: return false
      default: return true
      }
    }
    return false
  }
}

/// One owner, one reader. Cancellation closes the underlying socket, not just its waiter.
actor LineConnection {
  private let connection: NWConnection
  private var buffer = Data()
  private var scannedBytes = 0
  private enum ReadState { case open, eof, closed }
  private var readState = ReadState.open
  static let maximumFrameBytes = 4 * 1024 * 1024

  init(address: CoordinatorAddress) async throws {
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
    let host = try await Task.detached(priority: .userInitiated) { try address.resolvedHost() }
      .value
    try Task.checkCancellation()
    connection = NWConnection(host: .init(host), port: port, using: parameters)
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
      if CoordinatorAddress.isTailnetIP(value) { return value }
    }
    throw ConnectionError.vpnUnavailable
  }
  func close() {
    readState = .closed
    buffer.removeAll()
    scannedBytes = 0
    connection.cancel()
  }

  func send(_ request: NativeRequest) async throws {
    guard readState == .open else { throw ConnectionError.closed }
    let command = NativeCommand.native(.init(request: request))
    var bytes = try JSONEncoder().encode(command)
    guard bytes.count <= Self.maximumFrameBytes else { throw ConnectionError.frameTooLarge }
    bytes.append(10)
    let connection = connection
    do {
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
    } catch {
      close()
      throw error
    }
  }

  func next() async throws -> NativeEvent {
    let connection = connection
    do {
      return try await withTaskCancellationHandler {
        try await receiveFrame()
      } onCancel: {
        connection.cancel()
      }
    } catch {
      // A rejected or interrupted read must release the peer's pending write,
      // even when the owner has not resumed to observe this error yet.
      close()
      throw error
    }
  }

  private func receiveFrame() async throws -> NativeEvent {
    while true {
      try Task.checkCancellation()
      guard readState != .closed else { throw ConnectionError.closed }
      // Fragmented frames are scanned once, rather than rescanning every byte
      // already received while the peer continues writing.
      let start = buffer.index(buffer.startIndex, offsetBy: scannedBytes)
      if let newline = buffer[start...].firstIndex(of: 10) {
        guard newline - buffer.startIndex <= Self.maximumFrameBytes else {
          throw ConnectionError.frameTooLarge
        }
        let frame = buffer.prefix(upTo: newline)
        let event = try JSONDecoder().decode(NativeEvent.self, from: frame)
        buffer.removeSubrange(...newline)
        scannedBytes = 0
        return event
      }
      scannedBytes = buffer.count
      guard buffer.count <= Self.maximumFrameBytes else { throw ConnectionError.frameTooLarge }
      if readState == .eof {
        throw buffer.isEmpty ? ConnectionError.closed : ConnectionError.incompleteFrame
      }
      let (data, complete) = try await withCheckedThrowingContinuation {
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
      guard readState != .closed else { throw ConnectionError.closed }
      buffer.append(data)
      if complete { readState = .eof }
    }
  }
}
