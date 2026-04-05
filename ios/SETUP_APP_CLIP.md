# Setup App Clip Target in Xcode

## Prerequisites
- Apple Developer Account (already have)
- Xcode 15+

## Steps

### 1. Open project
```bash
open ios/App/App.xcodeproj
```

### 2. Add App Clip target
1. File → New → Target
2. Choose "App Clip"
3. Name: `TalkBridgeClip`
4. Bundle ID: `com.talkbridge.app.Clip`
5. Language: Swift
6. Interface: SwiftUI
7. Delete the auto-generated files (ContentView.swift, TalkBridgeClipApp.swift)

### 3. Add existing files to target
1. Right-click TalkBridgeClip group → Add Files
2. Add all files from `ios/App/TalkBridgeClip/`:
   - TalkBridgeClipApp.swift
   - ContentView.swift
   - IncomingCallView.swift
   - ActiveCallView.swift
   - EndedCallView.swift
   - AudioManager.swift
   - WebSocketManager.swift
   - APIClient.swift
   - CallManager.swift
   - Info.plist
3. Make sure "Add to targets: TalkBridgeClip" is checked

### 4. Configure App Clip
1. Select TalkBridgeClip target → General
2. Set Deployment Target to iOS 16.0
3. Go to Signing & Capabilities
4. Add "Associated Domains" capability
5. Add: `appclips:talk-bridge-mvp.onrender.com`

### 5. Configure main app
1. Select App target → Signing & Capabilities
2. Add "Associated Domains" capability
3. Add: `appclips:talk-bridge-mvp.onrender.com`

### 6. Server-side: Apple App Site Association
Add this route to Express server or serve as static file at `/.well-known/apple-app-site-association`:
```json
{
  "appclips": {
    "apps": ["TEAM_ID.com.talkbridge.app.Clip"]
  },
  "applinks": {
    "apps": [],
    "details": [{
      "appIDs": ["TEAM_ID.com.talkbridge.app.Clip"],
      "paths": ["/join/*"]
    }]
  }
}
```
Replace `TEAM_ID` with your Apple Developer Team ID.

### 7. Test
1. Build & Run TalkBridgeClip scheme on iPhone
2. Or: Settings → Developer → Local Experiences → Register App Clip URL:
   `https://talk-bridge-mvp.onrender.com/join/TEST_TOKEN`

### 8. QR codes
QR codes already point to `https://talk-bridge-mvp.onrender.com/join/{token}` —
iOS will automatically launch the App Clip when scanned (after AASA is configured).
