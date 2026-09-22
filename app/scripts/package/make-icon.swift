// Makes the macOS app icon from the product's square app icon (the one the mobile app uses):
// the artwork is drawn inside a rounded rectangle with the margins macOS icons keep (the icon fills
// about 80 % of the canvas), on a transparent background, at every size an .iconset needs.
// Usage: swift make-icon.swift <source.png> <out.iconset dir>   then: iconutil -c icns <out.iconset>
// System frameworks only; no dependency; run by scripts/package/make-icon.sh.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write("usage: make-icon.swift <source.png> <out.iconset>\n".data(using: .utf8)!); exit(2) }
let sourceURL = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
guard let src = CGImageSourceCreateWithURL(sourceURL as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  FileHandle.standardError.write("MAKE_ICON_FAILED SOURCE_UNREADABLE\n".data(using: .utf8)!); exit(1)
}
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func render(size: Int) -> CGImage? {
  let s = CGFloat(size)
  guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.clear(CGRect(x: 0, y: 0, width: s, height: s))
  // macOS icon grid: the rounded square spans 824/1024 of the canvas, corner radius about 22.4 % of its side.
  let side = s * 824.0 / 1024.0
  let inset = (s - side) / 2
  let rect = CGRect(x: inset, y: inset, width: side, height: side)
  let path = CGPath(roundedRect: rect, cornerWidth: side * 0.224, cornerHeight: side * 0.224, transform: nil)
  ctx.saveGState()
  ctx.addPath(path)
  ctx.clip()
  ctx.interpolationQuality = .high
  ctx.draw(image, in: rect)
  ctx.restoreGState()
  return ctx.makeImage()
}

func write(_ img: CGImage, to url: URL) -> Bool {
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(dest, img, nil)
  return CGImageDestinationFinalize(dest)
}

// The ten files an .iconset holds.
let entries: [(String, Int)] = [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)]
for (name, px) in entries {
  guard let img = render(size: px), write(img, to: outDir.appendingPathComponent("\(name).png")) else {
    FileHandle.standardError.write("MAKE_ICON_FAILED RENDER \(name)\n".data(using: .utf8)!); exit(1)
  }
}
print("MAKE_ICON_OK \(entries.count) sizes")
