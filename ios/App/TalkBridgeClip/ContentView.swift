import SwiftUI

struct ContentView: View {
    @EnvironmentObject var callManager: CallManager

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch callManager.state {
            case .waitingForLink:
                WaitingForLinkView()
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
                    Button("Try again") {
                        callManager.state = .waitingForLink
                    }
                    .foregroundColor(.blue)
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct WaitingForLinkView: View {
    @EnvironmentObject var callManager: CallManager
    @State private var linkText = ""

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "phone.arrow.down.left")
                .font(.system(size: 56))
                .foregroundColor(.green)

            Text("Talk Bridge")
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(.white)

            Text("Receiver")
                .font(.body)
                .foregroundColor(.gray)

            VStack(spacing: 12) {
                TextField("Paste invite link", text: $linkText)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .padding(.horizontal, 32)

                HStack(spacing: 16) {
                    Button("Paste") {
                        if let clip = UIPasteboard.general.string {
                            linkText = clip
                        }
                    }
                    .buttonStyle(.bordered)

                    Button("Connect") {
                        callManager.loadFromURL(linkText)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(linkText.isEmpty)
                }
            }

            Spacer()
        }
    }
}
