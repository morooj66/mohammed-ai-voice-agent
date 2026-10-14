// Scripted-demo 1080p encoder (local AVFoundation, no network): JPEG frames (exact 1920x1080, 1 per 1/30 s of the ORIGINAL audio time)
// + the original WAV -> H.264 1920x1080 30 fps CFR + AAC MP4, then full verification.
// Usage: swift encode.swift <framesDir> <original.wav> <out.mp4> <sheet.png>
import AVFoundation
import CoreImage
import AppKit
let args = CommandLine.arguments
let framesDir = URL(fileURLWithPath: args[1]), wavURL = URL(fileURLWithPath: args[2]), outURL = URL(fileURLWithPath: args[3]), sheetURL = URL(fileURLWithPath: args[4])
func fail(_ s: String) -> Never { print("FAIL:", s); exit(1) }
if FileManager.default.fileExists(atPath: outURL.path) { fail("refusing_to_overwrite") }
func load(_ asset: AVAsset, _ type: AVMediaType) -> AVAssetTrack { asset.tracks(withMediaType: type).first ?? { fail("no \(type.rawValue) track") }() }

// Mono float envelope (10 ms RMS) of an asset's audio, decoded to 48 kHz.
func envelope(_ asset: AVAsset) -> (env: [Float], peak: Float, seconds: Double) {
  let r = try! AVAssetReader(asset: asset)
  let o = AVAssetReaderTrackOutput(track: load(asset, .audio), outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false])
  r.add(o); r.startReading()
  var all = [Float]()
  while let sb = o.copyNextSampleBuffer(), let bb = CMSampleBufferGetDataBuffer(sb) {
    var len = 0; var ptr: UnsafeMutablePointer<CChar>?
    CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
    ptr!.withMemoryRebound(to: Float.self, capacity: len / 4) { all.append(contentsOf: UnsafeBufferPointer(start: $0, count: len / 4)) }
  }
  if r.status == .failed { fail("audio decode: \(r.error!)") }
  var env = [Float](); var peak: Float = 0
  stride(from: 0, to: all.count - 480, by: 480).forEach { i in var s: Float = 0; for j in i..<i + 480 { s += all[j] * all[j]; peak = max(peak, abs(all[j])) }; env.append(sqrt(s / 480)) }
  return (env, peak, Double(all.count) / 48000)
}
func bestLag(_ ref: [Float], _ y: [Float]) -> (lag: Int, r: Double) {
  var best = (0, -1.0)
  for lag in -60...60 { var xy = 0.0, xx = 0.0, yy = 0.0
    for i in 0..<ref.count { let k = i + lag; if k < 0 || k >= y.count { continue }; xy += Double(ref[i] * y[k]); xx += Double(ref[i] * ref[i]); yy += Double(y[k] * y[k]) }
    let r = xy / sqrt(xx * yy); if r > best.1 { best = (lag, r) } }
  return best
}


let wav = AVURLAsset(url: wavURL); let refEnv = envelope(wav)
let allFiles = try! FileManager.default.contentsOfDirectory(atPath: framesDir.path).filter { $0.hasSuffix(".jpg") }.sorted()
let fps: Int32 = 30
let wavDur = load(wav, .audio).timeRange.duration
// The WAV is the reference: AAC previews report a few ms of padding, so use at most round(wav * fps) frames.
let wantFrames = Int((wavDur.seconds * Double(fps)).rounded())
if abs(allFiles.count - wantFrames) > 2 { fail("frame count \(allFiles.count) does not match audio \(wavDur.seconds) s") }
let files = Array(allFiles.prefix(wantFrames))
let endTime = CMTime(value: CMTimeValue(files.count), timescale: fps)

let writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1920, AVVideoHeightKey: 1080,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel, AVVideoExpectedSourceFrameRateKey: 30, AVVideoMaxKeyFrameIntervalKey: 60]])
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 1920, kCVPixelBufferHeightKey as String: 1080])
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000])
aIn.expectsMediaDataInRealTime = false
writer.add(vIn); writer.add(aIn)
writer.startWriting(); writer.startSession(atSourceTime: .zero)

let ctx = CIContext()
let q = DispatchQueue(label: "enc"); let group = DispatchGroup()
group.enter(); var vi = 0
vIn.requestMediaDataWhenReady(on: q) {
  while vIn.isReadyForMoreMediaData && vi < files.count {
    autoreleasepool {
      let img = CIImage(contentsOf: framesDir.appendingPathComponent(files[vi]))!
      if img.extent.width != 1920 || img.extent.height != 1080 { fail("frame \(files[vi]) is \(img.extent)") }
      var pb: CVPixelBuffer?; CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
      ctx.render(img, to: pb!)
      if !adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(vi), timescale: fps)) { fail("append video \(writer.error!)") }
      vi += 1
    }
  }
  if vi >= files.count { vIn.markAsFinished(); group.leave() }
}
// Audio: the original WAV decoded to PCM (48 kHz mono) and encoded once to AAC, starting at t=0.
let ar = try! AVAssetReader(asset: wav)
let ao = AVAssetReaderTrackOutput(track: load(wav, .audio), outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false])
ar.add(ao); ar.startReading()
group.enter()
aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "aud")) {
  while aIn.isReadyForMoreMediaData {
    if let sb = ao.copyNextSampleBuffer() { if !aIn.append(sb) { fail("append audio \(writer.error!)") } }
    else { aIn.markAsFinished(); group.leave(); return }
  }
}
group.wait()
writer.endSession(atSourceTime: endTime)
let sem = DispatchSemaphore(value: 0); writer.finishWriting { sem.signal() }; sem.wait()
if writer.status != .completed { fail("writer: \(String(describing: writer.error))") }
print("ENCODED \(files.count) frames · audio from original WAV (\(String(format: "%.3f", wavDur.seconds)) s)")
// ---- Verify the output ----
let out = AVURLAsset(url: outURL)
let ov = load(out, .video), oa = load(out, .audio)
let r = try! AVAssetReader(asset: out)
let vo = AVAssetReaderTrackOutput(track: ov, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]); r.add(vo); r.startReading()
var frames = 0, sizes = [String: Int](), blanks = [Double](), last = -1.0, maxGap = 0.0, firstT = -1.0
while let sb = vo.copyNextSampleBuffer() {
  guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
  let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds; if firstT < 0 { firstT = t }
  if last >= 0 { maxGap = max(maxGap, t - last) }; last = t; frames += 1
  sizes["\(CVPixelBufferGetWidth(pb))x\(CVPixelBufferGetHeight(pb))", default: 0] += 1
  if frames % 5 == 1 { // luma spread on a coarse grid; a blank/solid frame has ~0 spread
    CVPixelBufferLockBaseAddress(pb, .readOnly); let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self); let bpr = CVPixelBufferGetBytesPerRow(pb)
    var s: Double = 0, s2: Double = 0, k: Double = 0
    for y in stride(from: 0, to: 1080, by: 20) { for x in stride(from: 0, to: 1920, by: 20) {
      let p: UnsafeMutablePointer<UInt8> = base + (y * bpr + x * 4)
      let bl: Double = 0.0722 * Double(p[0]); let gl: Double = 0.7152 * Double(p[1]); let rl: Double = 0.2126 * Double(p[2])
      let l: Double = bl + gl + rl
      s += l; s2 += l * l; k += 1 } }
    CVPixelBufferUnlockBaseAddress(pb, .readOnly); let m = s / k; if sqrt(s2 / k - m * m) < 4 { blanks.append(t) } }
}
if r.status == .failed { fail("video decode: \(r.error!)") }
let outEnv = envelope(out); let sync = bestLag(refEnv.env, outEnv.env)
var lastSpeech = 0.0; for (i, v) in outEnv.env.enumerated() where v > 0.01 { lastSpeech = Double(i + 1) / 100 }
let fmt = { (d: Double) in String(format: "%.3f", d) }
let attrs = try! FileManager.default.attributesOfItem(atPath: outURL.path)
print("OUTPUT \(outURL.lastPathComponent) · \(attrs[.size]!) bytes · container \(fmt(out.duration.seconds)) s")
print("VIDEO \((ov.formatDescriptions.first as! CMFormatDescription).mediaSubType) frames=\(frames) sizes=\(sizes) firstFrame=\(fmt(firstT)) lastFrame=\(fmt(last)) maxGap=\(fmt(maxGap)) fps≈\(fmt(Double(frames) / ov.timeRange.duration.seconds)) end=\(fmt(CMTimeRangeGetEnd(ov.timeRange).seconds)) blankSamples=\(blanks.count)")
print("AUDIO \((oa.formatDescriptions.first as! CMFormatDescription).mediaSubType) end=\(fmt(CMTimeRangeGetEnd(oa.timeRange).seconds)) peak=\(String(format: "%.3f", outEnv.peak)) lastSpeech=\(fmt(lastSpeech)) s · vs original WAV: offset \(sync.lag * 10) ms, correlation \(String(format: "%.3f", sync.r))")

// Contact sheet: 8 frames incl. the final ones.
let times = [0.5, 6, 15, 24, 35, 45, 50.3, max(0, CMTimeRangeGetEnd(ov.timeRange).seconds - 0.05)]
let og = AVAssetImageGenerator(asset: out); og.requestedTimeToleranceBefore = .zero; og.requestedTimeToleranceAfter = .zero
let sheet = NSImage(size: NSSize(width: 1920, height: 540)); sheet.lockFocus()
for (i, t) in times.enumerated() { if let img = try? og.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) {
  NSImage(cgImage: img, size: .zero).draw(in: NSRect(x: (i % 4) * 480, y: (1 - i / 4) * 270, width: 480, height: 270)) } }
sheet.unlockFocus()
let png = NSBitmapImageRep(data: sheet.tiffRepresentation!)!.representation(using: .png, properties: [:])!; try! png.write(to: sheetURL)
print("SHEET \(sheetURL.path) times=\(times.map { fmt($0) })")
