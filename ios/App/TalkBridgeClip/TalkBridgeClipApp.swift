import SwiftUI

@main
struct TalkBridgeClipApp: App {
    @StateObject private var callManager = CallManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(callManager)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let url = activity.webpageURL else { return }
                    // URL: https://talk-bridge-mvp.onrender.com/join/{token}
                    let token = url.lastPathComponent
                    if !token.isEmpty && token != "join" {
                        callManager.loadInvite(token: token)
                    }
                }
                .onOpenURL { url in
                    let token = url.lastPathComponent
                    if !token.isEmpty && token != "join" {
                        callManager.loadInvite(token: token)
                    }
                }
        }
    }
}
