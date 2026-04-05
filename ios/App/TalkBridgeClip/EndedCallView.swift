import SwiftUI

struct EndedCallView: View {
    @EnvironmentObject var callManager: CallManager

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "phone.down.circle.fill")
                .font(.system(size: 64))
                .foregroundColor(.gray)

            Text("Call ended")
                .font(.title)
                .foregroundColor(.white)

            if callManager.elapsedSeconds > 0 {
                Text(callManager.formattedTime)
                    .font(.title2)
                    .foregroundColor(.gray)
            }

            Spacer()
        }
    }
}
