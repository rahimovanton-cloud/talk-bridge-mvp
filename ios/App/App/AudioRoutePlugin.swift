import Capacitor
import AVFoundation

@objc(AudioRoutePlugin)
public class AudioRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioRoutePlugin"
    public let jsName = "AudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEarpiece", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSpeaker", returnType: CAPPluginReturnPromise),
    ]

    @objc func setEarpiece(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, options: [])
            try session.overrideOutputAudioPort(.none) // earpiece
            try session.setActive(true)
            call.resolve(["route": "earpiece"])
        } catch {
            call.reject("Failed to set earpiece: \(error.localizedDescription)")
        }
    }

    @objc func setSpeaker(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, options: [])
            try session.overrideOutputAudioPort(.speaker)
            try session.setActive(true)
            call.resolve(["route": "speaker"])
        } catch {
            call.reject("Failed to set speaker: \(error.localizedDescription)")
        }
    }
}
