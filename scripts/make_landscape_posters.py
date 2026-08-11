#!/usr/bin/env python3
import os
import json
from PIL import Image, ImageFilter, ImageEnhance, ImageOps, ImageDraw

POSTER_DIR = "web/public/posters"
TARGET_W, TARGET_H = 1280, 800  # 16:10 aspect ratio matching web player cards

def convert_to_landscape(input_path, output_path):
    if not os.path.exists(input_path):
        print(f"⚠️ Input poster not found: {input_path}")
        return False
    try:
        img = Image.open(input_path).convert("RGB")

        # 1. Background fill: scaled and heavily blurred ambient backdrop
        bg = ImageOps.fit(img, (TARGET_W, TARGET_H), method=Image.Resampling.LANCZOS)
        bg = bg.filter(ImageFilter.GaussianBlur(radius=50))
        bg = ImageEnhance.Brightness(bg).enhance(0.42)

        # 2. Foreground: scaled to fill 100% target height
        fg_h = TARGET_H
        fg_w = int(img.width * (fg_h / img.height))
        fg = img.resize((fg_w, fg_h), Image.Resampling.LANCZOS)

        # 3. Create smooth horizontal alpha mask for seamless edge blending
        mask = Image.new("L", (fg_w, fg_h), 255)
        draw = ImageDraw.Draw(mask)
        fade_px = int(fg_w * 0.20)
        for x in range(fade_px):
            alpha = int(255 * (x / fade_px))
            draw.line([(x, 0), (x, fg_h)], fill=alpha)
            draw.line([(fg_w - 1 - x, 0), (fg_w - 1 - x, fg_h)], fill=alpha)

        # 4. Composite centered foreground onto ambient background
        offset_x = (TARGET_W - fg_w) // 2
        bg.paste(fg, (offset_x, 0), mask)
        bg.save(output_path, "JPEG", quality=95)
        print(f"  ✅ Converted to 16:10 landscape: {os.path.basename(output_path)}")
        return True
    except Exception as e:
        print(f"  ❌ Error processing {input_path}: {e}")
        return False

def main():
    print("🎬 Generating 16:10 Landscape Key-Art Posters for StreamVault...")
    os.makedirs(POSTER_DIR, exist_ok=True)

    with open("movies.json", "r") as f:
        movies = json.load(f)

    processed = 0
    for m in movies:
        hls_name = m["hlsName"]
        poster_file = os.path.join(POSTER_DIR, f"{hls_name}.jpg")

        # Convert in-place or from existing file
        if convert_to_landscape(poster_file, poster_file):
            processed += 1

    print(f"\n🎉 Successfully processed {processed} landscape posters.")

if __name__ == "__main__":
    main()
