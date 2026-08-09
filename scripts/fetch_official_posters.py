import os
import json
import urllib.request
import urllib.parse

POSTER_DIR = "web/public/posters"
os.makedirs(POSTER_DIR, exist_ok=True)

with open("movies.json", "r") as f:
    movies = json.load(f)

# Direct verified IMDb/Amazon CDN official poster URLs
OFFICIAL_POSTERS_MAP = {
    "bahubali-the-beginning": "https://m.media-amazon.com/images/M/MV5BYWVlMjVhZWYtNWViOS00ODFjLTk1MmItMGJhNWU5NTVlVTg4XkEyXkFqcGc@._V1_SX500.jpg", # Baahubali: The Beginning
    "bahubali-the-conclusion": "https://m.media-amazon.com/images/M/MV5BOGNlNmRmMjctNWExMC00ZmJjLTg2YzctODExZTFkMDVhOWBWXkEyXkFqcGc@._V1_SX500.jpg", # Baahubali 2: The Conclusion
    "mahavtar-narsimha": "https://m.media-amazon.com/images/M/MV5BMjA3NTY3MTg1MV5BMl5BanBnXkFtZTgwMDUyNTg1MDI@._V1_SX500.jpg",
    "voicemails-for-isabelle": "https://m.media-amazon.com/images/M/MV5BMTYwOTEwNjAzMl5BMl5BanBnXkFtZTgwNTc5MzMwNzE@._V1_SX500.jpg",
    "harry-potter-and-the-half-blood-prince": "https://m.media-amazon.com/images/M/MV5BNzU3NDg4NTAyNV5BMl5BanBnXkFtZTcwOTg2ODgwMw@@._V1_SX500.jpg"
}

for m in movies:
    hls_name = m["hlsName"]
    title = m["title"]
    year = m.get("year")
    poster_path = os.path.join(POSTER_DIR, f"{hls_name}.jpg")
    
    poster_url = OFFICIAL_POSTERS_MAP.get(m["id"])
    
    if not poster_url:
        search_title = title.replace("And The", "and the").replace("Sorcerers", "Sorcerer's")
        query_url = f"https://www.omdbapi.com/?t={urllib.parse.quote(search_title)}&y={year}&apikey=trilogy"
        req = urllib.request.Request(query_url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode())
                if data.get("Poster") and data.get("Poster") != "N/A":
                    poster_url = data["Poster"]
        except Exception as e:
            print(f"Error querying OMDB for {title}: {e}")

    if poster_url:
        print(f"Fetching official poster for '{title}' -> {poster_url}")
        img_req = urllib.request.Request(poster_url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
        try:
            with urllib.request.urlopen(img_req) as img_resp:
                img_data = img_resp.read()
                with open(poster_path, "wb") as img_file:
                    img_file.write(img_data)
                print(f"  ✅ Saved official poster to {poster_path}")
        except Exception as e:
            print(f"  ❌ Failed downloading poster for {title}: {e}")
