import os
import json
import urllib.request
import urllib.parse

POSTER_DIR = "web/public/posters"
os.makedirs(POSTER_DIR, exist_ok=True)

with open("movies.json", "r") as f:
    movies = json.load(f)

# Direct map of movie ID to exact OMDB search query
OMDB_QUERY_MAP = {
    "bahubali-the-beginning": "Baahubali: The Beginning",
    "bahubali-the-conclusion": "Baahubali 2: The Conclusion",
    "mahavtar-narsimha": "Mahavatar Narsimha",
    "harry-potter-sorcerers-stone": "Harry Potter and the Sorcerer's Stone",
    "harry-potter-and-the-half-blood-prince": "Harry Potter and the Half-Blood Prince",
    "harry-potter-and-the-chamber-of-secrets": "Harry Potter and the Chamber of Secrets",
    "harry-potter-and-the-deathly-hallows-part-1": "Harry Potter and the Deathly Hallows: Part 1",
    "harry-potter-and-the-deathly-hallows-part-2": "Harry Potter and the Deathly Hallows: Part 2",
    "harry-potter-and-the-goblet-of-fire": "Harry Potter and the Goblet of Fire",
    "harry-potter-and-the-order-of-the-phoenix": "Harry Potter and the Order of the Phoenix",
    "voicemails-for-isabelle": "Voicemails for Isabelle",
    "harry-potter-and-the-prisoner-of-azkaban": "Harry Potter and the Prisoner of Azkaban",
    "gifted": "Gifted",
}

for m in movies:
    hls_name = m["hlsName"]
    movie_id = m["id"]
    query_title = OMDB_QUERY_MAP.get(movie_id, m["title"])
    poster_path = os.path.join(POSTER_DIR, f"{hls_name}.jpg")
    
    url = f"https://www.omdbapi.com/?t={urllib.parse.quote(query_title)}&apikey=trilogy"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    
    poster_url = None
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            if data.get("Poster") and data.get("Poster") != "N/A":
                poster_url = data["Poster"]
    except Exception as e:
        print(f"OMDB query error for {query_title}: {e}")

    if poster_url:
        print(f"Downloading official poster for '{m['title']}' from {poster_url}")
        img_req = urllib.request.Request(poster_url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
        try:
            with urllib.request.urlopen(img_req) as img_resp:
                img_data = img_resp.read()
                with open(poster_path, "wb") as img_file:
                    img_file.write(img_data)
                print(f"  ✅ Saved official poster to {poster_path}")
        except Exception as e:
            print(f"  ❌ Download error for {m['title']}: {e}")
    else:
        print(f"  ⚠️ Could not find official poster for {m['title']}")
