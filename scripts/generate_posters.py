import os
import json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

POSTER_DIR = "web/public/posters"
os.makedirs(POSTER_DIR, exist_ok=True)

with open("movies.json", "r") as f:
    movies = json.load(f)

# Palette themes for different movies
PALETTES = [
    ((35, 15, 10), (120, 50, 25), (210, 160, 90)),   # Warm Gold / Crimson (Baahubali)
    ((15, 25, 40), (45, 85, 130), (180, 210, 245)),  # Deep Blue / Cyan (Harry Potter)
    ((20, 25, 20), (50, 90, 65), (160, 220, 180)),   # Emerald / Forest (Fantasy)
    ((30, 20, 35), (90, 50, 100), (220, 170, 230)),  # Velvet Violet (Voicemails)
    ((40, 25, 15), (140, 80, 40), (240, 200, 140)),  # Warm Amber / Bronze (Gifted)
]

def create_poster(movie, index):
    width, height = 800, 1200
    p1, p2, glow_col = PALETTES[index % len(PALETTES)]

    # Base gradient image
    img = Image.new("RGB", (width, height), p1)
    draw = ImageDraw.Draw(img)

    # Render radial/diagonal gradient
    for y in range(height):
        ratio = y / height
        r = int(p1[0] * (1 - ratio) + p2[0] * ratio)
        g = int(p1[1] * (1 - ratio) + p2[1] * ratio)
        b = int(p1[2] * (1 - ratio) + p2[2] * ratio)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    # Add glowing orb in the upper center
    glow_img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_draw.ellipse([150, 150, 650, 650], fill=(glow_col[0], glow_col[1], glow_col[2], 65))
    glow_img = glow_img.filter(ImageFilter.GaussianBlur(120))
    img.paste(glow_img, (0, 0), glow_img)

    # Re-draw object for text
    draw = ImageDraw.Draw(img)

    # Border frame overlay
    draw.rectangle([30, 30, width - 30, height - 30], outline=(255, 255, 255, 30), width=2)
    draw.rectangle([45, 45, width - 45, height - 45], outline=(glow_col[0], glow_col[1], glow_col[2], 90), width=1)

    # Load default fonts
    try:
        font_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 54)
        font_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 28)
        font_meta = ImageFont.truetype("/System/Library/Fonts/Supplemental/Courier New.ttf", 22)
    except Exception:
        font_title = font_sub = font_meta = ImageFont.load_default()

    # Draw Eyebrow / Year
    year_text = f"FEATURE PRESENTATION · {movie.get('year', 2024)}"
    draw.text((width // 2, 120), year_text, fill=(210, 180, 140), font=font_meta, anchor="mm")

    # Draw Title
    title = movie.get("title", "")
    words = title.split()
    lines = []
    curr = []
    for w in words:
        curr.append(w)
        if len(" ".join(curr)) > 16:
            lines.append(" ".join(curr[:-1]))
            curr = [w]
    if curr:
        lines.append(" ".join(curr))

    y_pos = height // 2 - (len(lines) * 35)
    for line in lines:
        # Subtle shadow
        draw.text((width // 2 + 2, y_pos + 2), line, fill=(0, 0, 0, 180), font=font_title, anchor="mm")
        draw.text((width // 2, y_pos), line, fill=(255, 245, 235), font=font_title, anchor="mm")
        y_pos += 65

    # Draw Subtitle if present
    subtitle = movie.get("subtitle", "")
    if subtitle:
        draw.text((width // 2, y_pos + 20), subtitle, fill=(glow_col[0], glow_col[1], glow_col[2]), font=font_sub, anchor="mm")

    # Bottom watermark logo
    draw.text((width // 2, height - 90), "PRIVATE CINEMA COLLECTION", fill=(180, 150, 120), font=font_meta, anchor="mm")

    filename = f"{movie['hlsName']}.jpg"
    filepath = os.path.join(POSTER_DIR, filename)
    img.save(filepath, "JPEG", quality=90)
    print(f"Generated poster: {filepath}")

for idx, m in enumerate(movies):
    create_poster(m, idx)
