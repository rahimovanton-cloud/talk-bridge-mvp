import SwiftUI

struct ContentView: View {
    @EnvironmentObject var callManager: CallManager

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch callManager.state {
            case .loading:
                ProgressView("Loading...")
                    .foregroundColor(.white)
                    .tint(.white)
            case .incoming:
                IncomingCallView()
            case .connecting:
                VStack(spacing: 16) {
                    ProgressView()
                        .tint(.white)
                    Text("Connecting...")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            case .active:
                ActiveCallView()
            case .ended:
                EndedCallView()
            case .error(let message):
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 48))
                        .foregroundColor(.red)
                    Text(message)
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding()
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
