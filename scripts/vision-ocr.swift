import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else {
  fputs("Usage: vision-ocr.swift <image-path>\n", stderr)
  exit(2)
}

let imagePath = CommandLine.arguments[1]
let imageUrl = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageUrl) else {
  fputs("Could not load image: \(imagePath)\n", stderr)
  exit(1)
}

var rect = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
  fputs("Could not decode image: \(imagePath)\n", stderr)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.01

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
  try handler.perform([request])
  let lines = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  print(lines.joined(separator: "\n"))
} catch {
  fputs("Vision OCR failed: \(error.localizedDescription)\n", stderr)
  exit(1)
}
