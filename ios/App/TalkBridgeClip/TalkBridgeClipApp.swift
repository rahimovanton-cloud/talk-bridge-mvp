import SwiftUI

@main
struct TalkBridgeClipApp: App {
    @StateObject private var callManager = CallManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(callManager)
                .onOpenURL { url in
                    let token = url.lastPathComponent
                    if !token.isEmpty && token != "join" {
                        callManager.loadInvite(token: token)
                    }
                }
        }
    }
}
