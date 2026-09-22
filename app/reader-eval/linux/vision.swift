// Apple Vision on the same Linux-rendered images, with the reader's settings (accurate, no language
// correction, en-US then pt-BR). A rough reference only: lines are put in order by a simple
// top-to-bottom sort here, not by the reader's own text.rs, so a misordered line costs accuracy.
import Foundation
import ImageIO
import Vision

let dir = CommandLine.arguments[1]
var out: [String: [String: Any]] = [:]
for file in try! FileManager.default.contentsOfDirectory(atPath: dir + "/img").sorted() where file.hasSuffix(".png") {
  let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: dir + "/img/" + file) as CFURL, nil)!
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.recognitionLanguages = ["en-US", "pt-BR"]
  var times: [Double] = []
  for _ in 0..<3 {
    let started = Date()
    try! VNImageRequestHandler(cgImage: image).perform([request])
    times.append(Date().timeIntervalSince(started) * 1000)
  }
  let lines = (request.results ?? []).sorted {
    abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.005
      ? $0.boundingBox.midY > $1.boundingBox.midY : $0.boundingBox.minX < $1.boundingBox.minX
  }
  out[String(file.dropLast(4))] = [
    "text": lines.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"),
    "ms": Int(times.sorted()[1].rounded()),
  ]
}
FileManager.default.createFile(atPath: dir + "/vision.json", contents: try! JSONSerialization.data(withJSONObject: out))
print("vision done")
