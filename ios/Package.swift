// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Agent",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "AgentUI", targets: ["AgentUI"])],
  targets: [
    .target(name: "AgentCore"),
    .target(name: "AgentUI", dependencies: ["AgentCore"]),
    .testTarget(
      name: "AgentCoreTests", dependencies: ["AgentCore", "AgentUI"], resources: [.copy("Fixtures")]
    ),
  ],
  swiftLanguageModes: [.v6]
)
