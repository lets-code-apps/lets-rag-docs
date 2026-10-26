// Apple Vision OCR: prints the text of each image, pages separated by a form feed.
// Usage: vision-ocr <image>...   (ocr.py compiles and calls this)
import Foundation
import Vision

var pages: [String] = []
for path in CommandLine.arguments.dropFirst() {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["pl-PL", "ru-RU", "uk-UA", "en-US"]
    try VNImageRequestHandler(url: URL(fileURLWithPath: path)).perform([request])
    pages.append((request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
}
print(pages.joined(separator: "\u{0C}"))
