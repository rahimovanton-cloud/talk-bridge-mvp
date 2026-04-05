import SwiftUI

struct ActiveCallView: View {
    @EnvironmentObject var callManager: CallManager
    @State private var endOffset: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Timer
            Text(callManager.formattedTime)
                .font(.system(size: 56, weight: .light, design: .monospaced))
                .foregroundColor(.white)
                .padding(.bottom, 8)

            Text("Translation active")
                .font(.body)
                .foregroundColor(.green)

            Spacer()

            // End swipe
            SwipeControl(color: .red, label: "Slide to end") {
                callManager.endCall()
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
        }
    }
}
