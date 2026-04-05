import SwiftUI

struct IncomingCallView: View {
    @EnvironmentObject var callManager: CallManager
    @State private var dragOffset: CGFloat = 0
    @State private var isShaking = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Client photo
            if let photoUrl = callManager.session?.clientPhotoUrl,
               let url = URL(string: "https://talk-bridge-mvp.onrender.com\(photoUrl)") {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    Circle()
                        .fill(Color.gray.opacity(0.3))
                }
                .frame(width: 120, height: 120)
                .clipShape(Circle())
                .padding(.bottom, 16)
            }

            // Client name
            Text(callManager.session?.clientName ?? "Unknown")
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(.white)
                .padding(.bottom, 8)

            Text("Incoming call")
                .font(.body)
                .foregroundColor(.gray)
                .modifier(ShakeModifier(isShaking: isShaking))

            Spacer()

            // Accept swipe
            swipeRail(color: .green, label: "Slide to answer") {
                callManager.acceptCall()
            }
            .padding(.bottom, 20)

            // Decline swipe
            swipeRail(color: .red, label: "Slide to decline") {
                callManager.endCall()
            }
            .padding(.bottom, 40)
        }
        .padding(.horizontal, 24)
        .onAppear {
            isShaking = true
        }
    }

    @ViewBuilder
    func swipeRail(color: Color, label: String, action: @escaping () -> Void) -> some View {
        SwipeControl(color: color, label: label, onComplete: action)
    }
}

struct SwipeControl: View {
    let color: Color
    let label: String
    let onComplete: () -> Void

    @State private var offset: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let maxOffset = geo.size.width - 64 - 8
            ZStack(alignment: .leading) {
                // Rail background
                RoundedRectangle(cornerRadius: 32)
                    .fill(Color.white.opacity(0.1))

                // Fill
                RoundedRectangle(cornerRadius: 32)
                    .fill(color.opacity(0.3))
                    .frame(width: offset + 64)

                // Label
                Text(label)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.white.opacity(0.5))
                    .frame(maxWidth: .infinity)

                // Thumb
                Circle()
                    .fill(color)
                    .frame(width: 56, height: 56)
                    .overlay(
                        Image(systemName: color == .green ? "phone.fill" : "phone.down.fill")
                            .foregroundColor(.white)
                            .font(.system(size: 22))
                    )
                    .offset(x: offset + 4)
                    .gesture(
                        DragGesture()
                            .onChanged { value in
                                offset = max(0, min(maxOffset, value.translation.width))
                            }
                            .onEnded { _ in
                                if offset >= maxOffset * 0.75 {
                                    withAnimation(.easeOut(duration: 0.15)) { offset = maxOffset }
                                    onComplete()
                                } else {
                                    withAnimation(.spring()) { offset = 0 }
                                }
                            }
                    )
            }
        }
        .frame(height: 64)
    }
}

struct ShakeModifier: ViewModifier {
    let isShaking: Bool

    func body(content: Content) -> some View {
        if isShaking {
            content
                .modifier(ShakeEffect(shakes: 2))
        } else {
            content
        }
    }
}

struct ShakeEffect: GeometryEffect {
    var shakes: CGFloat
    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        let translation = sin(shakes * .pi * 2) * 4
        return ProjectionTransform(CGAffineTransform(translationX: translation, y: 0))
    }
}
