#if AGENT_APP_HOST
  import Foundation
  import Testing

  import AgentCore

  @Test func embeddedShareAndHostResolveTheSameAppGroupWithoutMovingLegacyStorage() throws {
    let host = Bundle.main
    let plugins = try #require(host.builtInPlugInsURL)
    let extensionBundle = try #require(Bundle(url: plugins.appending(path: "AgentShare.appex")))
    let group = try #require(
      host.object(forInfoDictionaryKey: SharedDraftInbox.configurationKey) as? String)
    #expect(group.hasPrefix("group."))
    #expect(!group.contains("$("))
    #expect(
      extensionBundle.object(forInfoDictionaryKey: SharedDraftInbox.configurationKey) as? String
        == group)
    #expect(
      extensionBundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        == host.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
    _ = try SharedDraftInbox.configured(bundle: host)
    _ = try SharedDraftInbox.configured(bundle: extensionBundle)
    #expect(host.bundleIdentifier == "dev.jessfraz.Agent")
  }
#endif
