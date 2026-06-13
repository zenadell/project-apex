import AVFoundation
import AppKit
import Foundation

class WebcamCapture: NSObject, AVCapturePhotoCaptureDelegate {
    let session = AVCaptureSession()
    let output = AVCapturePhotoOutput()
    var outputPath: String
    let semaphore = DispatchSemaphore(value: 0)
    var captureSuccess = false
    
    init(outputPath: String) {
        self.outputPath = outputPath
        super.init()
    }
    
    func capture() -> Bool {
        session.sessionPreset = .photo
        
        guard let device = AVCaptureDevice.default(for: .video) else {
            fputs("ERROR: No camera found\n", stderr)
            return false
        }
        
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            fputs("ERROR: Could not create camera input\n", stderr)
            return false
        }
        
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) { session.addOutput(output) }
        
        session.startRunning()
        
        // Give camera 1.5 seconds to warm up (auto-exposure/focus)
        Thread.sleep(forTimeInterval: 1.5)
        
        let settings = AVCapturePhotoSettings(format: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        
        output.capturePhoto(with: settings, delegate: self)
        
        // Wait up to 10 seconds for capture
        let result = semaphore.wait(timeout: .now() + 10)
        session.stopRunning()
        
        if result == .timedOut {
            fputs("ERROR: Capture timed out\n", stderr)
            return false
        }
        
        return captureSuccess
    }
    
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error = error {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            semaphore.signal()
            return
        }
        
        guard let imageData = photo.fileDataRepresentation() else {
            fputs("ERROR: Could not get image data\n", stderr)
            semaphore.signal()
            return
        }
        
        guard let image = NSImage(data: imageData) else {
            fputs("ERROR: Could not create image\n", stderr)
            semaphore.signal()
            return
        }
        
        // Convert to JPEG
        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let jpegData = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            fputs("ERROR: Could not convert to JPEG\n", stderr)
            semaphore.signal()
            return
        }
        
        do {
            try jpegData.write(to: URL(fileURLWithPath: outputPath))
            captureSuccess = true
            print(outputPath)  // Output the path on success
        } catch {
            fputs("ERROR: Could not write file: \(error.localizedDescription)\n", stderr)
        }
        
        semaphore.signal()
    }
}

// Main
let outputPath = CommandLine.arguments.count > 1 
    ? CommandLine.arguments[1] 
    : "/tmp/apex-webcam-\(Int(Date().timeIntervalSince1970)).jpg"

let capture = WebcamCapture(outputPath: outputPath)
exit(capture.capture() ? 0 : 1)
