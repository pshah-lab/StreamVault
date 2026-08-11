import Hls from "hls.js";
import "./style.css";

// ── Types ──

type CatalogEntry = {
  id: string;
  title: string;
  subtitle: string;
  year: number;
  hlsName: string;
  outputPrefix: string;
  sourceFile: string;
  multiAudio?: boolean;
  subtitles?: boolean;
  poster?: string;
};

type Movie = {
  id: string;
  label: string;
  eyebrow: string;
  titleHtml: string;
  playlist: string;
  posterLabel: string;
  rawTitle: string;
  rawSubtitle: string;
  poster?: string;
  year: number;
  multiAudio: boolean;
  subtitles: boolean;
};

// ── Globals ──
let catalog: CatalogEntry[] = [];
let movies: Movie[] = [];
let movieCards: HTMLElement[] = [];
const movieById = new Map<string, Movie>();
let activeMovie: Movie | undefined;
let activeHls: Hls | undefined;
let isPlayerOpen = false;
let activeCategory = "all";

// ── Card Color Palette ──
const CARD_PALETTES = [
  { glow: "rgba(255, 211, 145, .42)", grad1: "#20120d", grad2: "#5a2418", grad3: "#0d1119", accent: "#bf8e63" },
  { glow: "rgba(255, 201, 103, .36)", grad1: "#071119", grad2: "#1e3c42", grad3: "#3b1d13", accent: "#63a6ae" },
  { glow: "rgba(186, 145, 255, .36)", grad1: "#120d20", grad2: "#3b1858", grad3: "#19110d", accent: "#9b6ebf" },
  { glow: "rgba(145, 255, 186, .36)", grad1: "#0d1912", grad2: "#185a3b", grad3: "#0d1119", accent: "#63bf8e" },
  { glow: "rgba(255, 145, 170, .36)", grad1: "#190d12", grad2: "#5a1830", grad3: "#110d19", accent: "#bf6378" },
  { glow: "rgba(145, 200, 255, .36)", grad1: "#0d1219", grad2: "#183a5a", grad3: "#19110d", accent: "#6396bf" },
];

function catalogToMovie(entry: CatalogEntry, index: number): Movie {
  const playlistName = (entry.multiAudio || entry.subtitles) ? "master.m3u8" : `${entry.hlsName}.m3u8`;
  return {
    id: entry.id,
    label: "",
    eyebrow: `FEATURE PRESENTATION · ${entry.year}`,
    titleHtml: `${entry.title}:${entry.subtitle ? `<br /><em>${entry.subtitle}</em>` : ""}`,
    playlist: `/${entry.outputPrefix}/${playlistName}`,
    posterLabel: `${entry.title}${entry.subtitle ? `: ${entry.subtitle}` : ""}`,
    rawTitle: entry.title,
    rawSubtitle: entry.subtitle || "",
    poster: entry.poster ? `${import.meta.env.BASE_URL}${entry.poster}` : undefined,
    year: entry.year,
    multiAudio: Boolean(entry.multiAudio),
    subtitles: Boolean(entry.subtitles),
  };
}

// ── DOM Selection ──
const video = document.querySelector<HTMLVideoElement>("#player")!;
const errorPanel = document.querySelector<HTMLElement>("#player-error")!;
const errorTitle = document.querySelector<HTMLElement>("#player-error-title")!;
const errorDetail = document.querySelector<HTMLElement>("#player-error-detail")!;
const sessionState = document.querySelector<HTMLElement>("#session-state")!;
const title = document.querySelector<HTMLElement>("#title")!;
const eyebrowEl = document.querySelector<HTMLElement>("#movie-eyebrow")!;
const expandedPlayer = document.querySelector<HTMLElement>("#expanded-player")!;
const backdrop = document.querySelector<HTMLElement>("#player-backdrop")!;
const closeBtn = document.querySelector<HTMLElement>("#close-player")!;

const audioPickerEl = document.querySelector<HTMLElement>("#audio-picker")!;
const audioPickerBtnEl = document.querySelector<HTMLButtonElement>("#audio-picker-btn")!;
const audioCurrentEl = document.querySelector<HTMLElement>("#audio-current")!;
const audioMenuEl = document.querySelector<HTMLElement>("#audio-menu")!;

const subtitlePickerEl = document.querySelector<HTMLElement>("#subtitle-picker")!;
const subtitlePickerBtnEl = document.querySelector<HTMLButtonElement>("#subtitle-picker-btn")!;
const subtitleCurrentEl = document.querySelector<HTMLElement>("#subtitle-current")!;
const subtitleMenuEl = document.querySelector<HTMLElement>("#subtitle-menu")!;

const heroTitle = document.querySelector<HTMLElement>("#hero-title")!;
const heroSubtitle = document.querySelector<HTMLElement>("#hero-subtitle")!;
const heroBg = document.querySelector<HTMLElement>("#hero-bg")!;
const heroYearTag = document.querySelector<HTMLElement>("#hero-year-tag")!;
const heroPlayBtn = document.querySelector<HTMLButtonElement>("#hero-play-btn")!;
const heroDetailsBtn = document.querySelector<HTMLButtonElement>("#hero-details-btn")!;

const API_URL = window.location.origin.includes("localhost") ? "http://localhost:8000" : "";

function getHeaders() {
  return { "Content-Type": "application/json" };
}

// ── Hero Spotlight ──
let spotlightMovie: Movie | undefined;

function renderHeroSpotlight(movie: Movie) {
  spotlightMovie = movie;
  heroTitle.textContent = movie.rawTitle;
  heroSubtitle.textContent = movie.rawSubtitle || "Stream Vault Presentation";
  heroYearTag.textContent = movie.year.toString();
  if (movie.poster && heroBg) {
    heroBg.style.backgroundImage = `url('${movie.poster}')`;
  }
}

heroPlayBtn?.addEventListener("click", () => {
  if (spotlightMovie) void selectMovie(spotlightMovie);
});

heroDetailsBtn?.addEventListener("click", () => {
  document.querySelector(".library")?.scrollIntoView({ behavior: "smooth" });
});

// ── Render Movie Cards ──
function renderMovieCards(): HTMLElement[] {
  const rail = document.querySelector<HTMLElement>("#movie-rail");
  if (!rail) return [];

  rail.innerHTML = "";
  const cards: HTMLElement[] = [];

  movies.forEach((movie, index) => {
    const entry = catalog[index];
    const palette = CARD_PALETTES[index % CARD_PALETTES.length];

    const article = document.createElement("article");
    article.className = "movie-card";
    article.dataset.movieId = movie.id;
    article.setAttribute("role", "listitem");
    article.style.setProperty("--card-glow", palette.glow);
    article.style.setProperty("--card-grad1", palette.grad1);
    article.style.setProperty("--card-grad2", palette.grad2);
    article.style.setProperty("--card-grad3", palette.grad3);
    article.style.setProperty("--card-accent", palette.accent);

    article.innerHTML = `
      <button class="movie-select" type="button" aria-label="Play ${movie.posterLabel}">
        ${movie.poster ? `<div class="movie-card-bg" style="background-image: url('${movie.poster}')"></div>` : ""}
        <span class="poster-meta">${entry.year}</span>
        <strong>${entry.title}</strong>
        ${entry.subtitle ? `<em>${entry.subtitle}</em>` : ""}
        <span class="play-pill">Play</span>
      </button>
    `;

    article.querySelector(".movie-select")?.addEventListener("click", () => {
      void selectMovie(movie);
    });

    rail.appendChild(article);
    cards.push(article);
  });

  return cards;
}

// ── Player Open/Close ──
function openPlayer() {
  isPlayerOpen = true;
  document.body.classList.add("player-open");
  backdrop.classList.add("is-visible");
  expandedPlayer.classList.add("is-open");
}

function closePlayer() {
  if (!isPlayerOpen) return;
  isPlayerOpen = false;

  expandedPlayer.classList.remove("is-open");
  backdrop.classList.remove("is-visible");
  document.body.classList.remove("player-open");

  resetPlayer();
  renderContinueWatching();
}

function resetPlayer() {
  activeHls?.destroy();
  activeHls = undefined;
  video.removeAttribute("src");
  video.load();
  hideAccessError();
  audioPickerEl.hidden = true;
  audioMenuEl.hidden = true;
  audioPickerBtnEl.setAttribute("aria-expanded", "false");
  subtitlePickerEl.hidden = true;
  subtitleMenuEl.hidden = true;
  subtitlePickerBtnEl.setAttribute("aria-expanded", "false");
}

function showAccessError(detail = "Session expired", titleText = "Playback interrupted") {
  errorPanel.hidden = false;
  errorPanel.style.display = "flex";
  errorTitle.textContent = titleText;
  errorDetail.textContent = detail;
  sessionState.textContent = "Session expired";
}

function hideAccessError() {
  errorPanel.hidden = true;
  errorPanel.style.display = "none";
}

video.addEventListener("play", () => hideAccessError());
video.addEventListener("playing", () => hideAccessError());

// ── Language utilities & Audio/Subtitle Track UI ──
function getLanguageName(langCode: string): string {
  const customMap: Record<string, string> = {
    tel: "Telugu", hin: "Hindi", tam: "Tamil", mal: "Malayalam", kan: "Kannada", eng: "English"
  };
  const code = langCode.toLowerCase().trim();
  if (customMap[code]) return customMap[code];
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(code) || langCode;
  } catch {
    return langCode;
  }
}

function setupHlsAudioTracks(hls: Hls) {
  const tracks = hls.audioTracks;
  if (tracks.length > 1) {
    audioPickerEl.hidden = false;
    audioMenuEl.innerHTML = "";

    const currentTrackIdx = hls.audioTrack;
    const currentTrack = tracks[currentTrackIdx] || tracks[0];
    audioCurrentEl.textContent = getLanguageName(currentTrack.lang || currentTrack.name);

    tracks.forEach((track) => {
      const li = document.createElement("li");
      li.className = "audio-picker-item";
      if (track.id === currentTrack.id) li.classList.add("is-selected");
      li.textContent = getLanguageName(track.lang || track.name);
      li.setAttribute("role", "option");
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        hls.audioTrack = track.id;
        audioCurrentEl.textContent = getLanguageName(track.lang || track.name);
        audioMenuEl.hidden = true;
        audioPickerBtnEl.setAttribute("aria-expanded", "false");

        audioMenuEl.querySelectorAll(".audio-picker-item").forEach((item, idx) => {
          item.classList.toggle("is-selected", idx === track.id);
        });
      });
      audioMenuEl.appendChild(li);
    });
  } else {
    audioPickerEl.hidden = true;
  }
}

function setupHlsSubtitles(hls: Hls) {
  const tracks = hls.subtitleTracks;
  if (tracks.length > 0) {
    subtitlePickerEl.hidden = false;
    subtitleMenuEl.innerHTML = "";

    const offLi = document.createElement("li");
    offLi.className = "subtitle-picker-item";
    if (hls.subtitleTrack === -1) {
      offLi.classList.add("is-selected");
      subtitleCurrentEl.textContent = "Subtitles: Off";
    } else {
      subtitleCurrentEl.textContent = "Subtitles";
    }
    offLi.textContent = "Off";
    offLi.setAttribute("role", "option");
    offLi.addEventListener("click", (e) => {
      e.stopPropagation();
      hls.subtitleTrack = -1;
      subtitleCurrentEl.textContent = "Subtitles: Off";
      subtitleMenuEl.hidden = true;
      subtitlePickerBtnEl.setAttribute("aria-expanded", "false");

      subtitleMenuEl.querySelectorAll(".subtitle-picker-item").forEach((item, idx) => {
        item.classList.toggle("is-selected", idx === 0);
      });
    });
    subtitleMenuEl.appendChild(offLi);

    tracks.forEach((track, index) => {
      const li = document.createElement("li");
      li.className = "subtitle-picker-item";
      if (hls.subtitleTrack === index) {
        li.classList.add("is-selected");
        subtitleCurrentEl.textContent = `Subtitles: ${getLanguageName(track.lang || track.name)}`;
      }
      li.textContent = getLanguageName(track.lang || track.name);
      li.setAttribute("role", "option");
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        hls.subtitleTrack = index;
        subtitleCurrentEl.textContent = `Subtitles: ${getLanguageName(track.lang || track.name)}`;
        subtitleMenuEl.hidden = true;
        subtitlePickerBtnEl.setAttribute("aria-expanded", "false");

        subtitleMenuEl.querySelectorAll(".subtitle-picker-item").forEach((item, idx) => {
          item.classList.toggle("is-selected", idx === (index + 1));
        });
      });
      subtitleMenuEl.appendChild(li);
    });
  } else {
    subtitlePickerEl.hidden = true;
  }
}

// ── Continue Watching Rail ──
function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}:${s.toString().padStart(2, "0")}`;
}

function renderContinueWatching() {
  const continueSection = document.querySelector<HTMLElement>("#continue-watching-section");
  const continueRail = document.querySelector<HTMLElement>("#continue-watching-rail");
  if (!continueSection || !continueRail) return;

  continueRail.innerHTML = "";
  let count = 0;

  for (const movie of movies) {
    const savedTimeRaw = localStorage.getItem(`hls_progress_${movie.id}`);
    if (!savedTimeRaw) continue;
    const savedTime = parseFloat(savedTimeRaw);
    if (isNaN(savedTime) || savedTime <= 10) continue;

    count++;
    const card = document.createElement("div");
    card.className = "continue-card";
    card.setAttribute("role", "listitem");

    const estimatedPercent = Math.min(95, Math.max(5, Math.round((savedTime / 7200) * 100)));

    card.innerHTML = `
      ${movie.poster ? `<div class="movie-card-bg" style="background-image: url('${movie.poster}')"></div>` : ""}
      <div class="continue-card-top">
        <h3 class="continue-card-title">${movie.rawTitle}</h3>
        ${movie.rawSubtitle ? `<p class="continue-card-subtitle">${movie.rawSubtitle}</p>` : ""}
      </div>
      <div class="continue-card-bottom">
        <div class="resume-badge">
          <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Resume (${formatTime(savedTime)})
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${estimatedPercent}%"></div>
        </div>
      </div>
    `;

    card.addEventListener("click", () => {
      void selectMovie(movie);
    });

    continueRail.appendChild(card);
  }

  continueSection.hidden = count === 0;
}

async function savePlaybackProgress(movieId: string, seconds: number) {
  if (!movieId || seconds <= 0) return;
  try {
    localStorage.setItem(`hls_progress_${movieId}`, seconds.toString());
    renderContinueWatching();
    await fetch(`${API_URL}/api/progress`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ movie_id: movieId, seconds }),
    });
  } catch (err) {
    console.warn("Progress sync warn:", err);
  }
}

let lastSavedTime = 0;
let lastSavedMovieId = "";

video.addEventListener("timeupdate", () => {
  if (!video.paused && video.currentTime > 0 && !errorPanel.hidden) {
    hideAccessError();
  }

  const currentTime = video.currentTime;
  if (!activeMovie) return;

  if (activeMovie.id !== lastSavedMovieId) {
    lastSavedMovieId = activeMovie.id;
    lastSavedTime = currentTime;
    return;
  }

  if (Math.abs(currentTime - lastSavedTime) >= 5) {
    lastSavedTime = currentTime;
    void savePlaybackProgress(activeMovie.id, currentTime);
  }
});

// ── Load & Play Video Stream ──
async function loadPlayer(movie: Movie) {
  resetPlayer();

  title.innerHTML = movie.titleHtml;
  eyebrowEl.textContent = movie.eyebrow;

  let startSeconds = 0;
  const localSaved = localStorage.getItem(`hls_progress_${movie.id}`);
  if (localSaved) {
    const parsed = parseFloat(localSaved);
    if (!isNaN(parsed) && parsed > 0) startSeconds = parsed;
  }

  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup(xhr) {
        xhr.withCredentials = true;
      },
    });
    activeHls = hls;
    hls.loadSource(movie.playlist);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hideAccessError();
      setupHlsAudioTracks(hls);
      setupHlsSubtitles(hls);
      if (startSeconds > 0) video.currentTime = startSeconds;
      video.play().catch((e) => console.log("Autoplay prevented:", e));
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      console.warn("HLS event note:", data);

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (data.response?.code === 403) {
          if (!video.paused && video.currentTime > 0) {
            // Video is actively playing, ignore background 403 check
            return;
          }
          showAccessError("Your session token has expired. Please sign in again.", "Access Denied (403)");
          return;
        }
        hls.startLoad();
        return;
      }

      if (data.fatal && (video.paused || video.currentTime === 0)) {
        showAccessError(`Playback error: ${data.details}`);
      }
    });
    return;
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = movie.playlist;
    if (startSeconds > 0) video.currentTime = startSeconds;
    video.play().catch((e) => console.log("Autoplay prevented:", e));
    return;
  }

  showAccessError("Your browser does not support HLS streaming.");
}

async function selectMovie(movie: Movie) {
  activeMovie = movie;
  hideAccessError();
  sessionState.textContent = "Loading stream...";
  openPlayer();
  try {
    await loadPlayer(movie);
    sessionState.textContent = "Secure session active";
  } catch (err) {
    showAccessError(err instanceof Error ? err.message : "Failed loading movie.");
  }
}

// ── Search & Filter Logic ──
function filterMovies() {
  const searchInput = document.querySelector<HTMLInputElement>("#movie-search");
  const query = searchInput?.value.trim().toLowerCase() || "";
  const noResultsEl = document.querySelector<HTMLElement>("#no-search-results");

  let visibleCount = 0;

  movieCards.forEach((card) => {
    const movieId = card.dataset.movieId ?? "";
    const movie = movieById.get(movieId);
    if (!movie) return;

    // Search query match
    const titleMatch = movie.rawTitle.toLowerCase().includes(query);
    const subtitleMatch = movie.rawSubtitle.toLowerCase().includes(query);
    const yearMatch = movie.year.toString().includes(query);
    const queryMatch = !query || titleMatch || subtitleMatch || yearMatch;

    // Category chip match
    let categoryMatch = true;
    if (activeCategory === "fantasy") {
      categoryMatch = movie.rawTitle.toLowerCase().includes("harry") || movie.rawTitle.toLowerCase().includes("baahubali");
    } else if (activeCategory === "action") {
      categoryMatch = movie.rawTitle.toLowerCase().includes("mahavtar") || movie.rawTitle.toLowerCase().includes("baahubali");
    } else if (activeCategory === "multiaudio") {
      categoryMatch = movie.multiAudio;
    } else if (activeCategory === "subtitles") {
      categoryMatch = movie.subtitles;
    }

    const show = queryMatch && categoryMatch;
    card.style.display = show ? "" : "none";
    if (show) visibleCount++;
  });

  if (noResultsEl) {
    noResultsEl.hidden = visibleCount > 0;
  }
}

function setupCategoryChips() {
  const chips = document.querySelectorAll<HTMLButtonElement>("#category-chips .chip");
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => {
        c.classList.remove("is-active");
        c.setAttribute("aria-selected", "false");
      });
      chip.classList.add("is-active");
      chip.setAttribute("aria-selected", "true");
      activeCategory = chip.dataset.category || "all";
      filterMovies();
    });
  });
}

function setupSearch() {
  const searchInput = document.querySelector<HTMLInputElement>("#movie-search");
  searchInput?.addEventListener("input", filterMovies);
}

// ── Keyboard Shortcuts Handler ──
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Ctrl+K or Cmd+K: Focus search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      document.querySelector<HTMLInputElement>("#movie-search")?.focus();
      return;
    }

    // Escape key
    if (e.key === "Escape") {
      if (isPlayerOpen) {
        closePlayer();
      } else {
        audioMenuEl.hidden = true;
        subtitleMenuEl.hidden = true;
      }
      return;
    }

    // Don't intercept when user is typing in search input
    if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
      return;
    }

    if (!isPlayerOpen) return;

    switch (e.code) {
      case "Space":
      case "KeyK":
        e.preventDefault();
        if (video.paused) {
          void video.play();
        } else {
          video.pause();
        }
        break;
      case "KeyF":
        e.preventDefault();
        if (document.fullscreenElement) {
          void document.exitFullscreen();
        } else {
          void video.requestFullscreen();
        }
        break;
      case "KeyM":
        e.preventDefault();
        video.muted = !video.muted;
        break;
      case "ArrowLeft":
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case "ArrowRight":
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        break;
      case "ArrowUp":
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        break;
    }
  });
}

// ── App Initialization ──
async function init() {
  try {
    sessionState.textContent = "Checking session…";

    const response = await fetch(`${import.meta.env.BASE_URL}movies.json`);
    if (!response.ok) throw new Error("Failed loading catalog.");
    catalog = (await response.json()) as CatalogEntry[];
    movies = catalog.map(catalogToMovie);
    movies.forEach((m) => movieById.set(m.id, m));

    if (movies.length > 0) {
      renderHeroSpotlight(movies[0]);
    }

    movieCards = renderMovieCards();
    setupCategoryChips();
    setupSearch();
    setupKeyboardShortcuts();
    renderContinueWatching();

    sessionState.textContent = "Private cinema ready";
  } catch (err) {
    console.error("Init error:", err);
    showAccessError(err instanceof Error ? err.message : "Unable to load library.", "Library Error");
  }
}

// ── Close & Picker Toggles ──
closeBtn.addEventListener("click", closePlayer);
backdrop.addEventListener("click", closePlayer);

audioPickerBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  subtitleMenuEl.hidden = true;
  subtitlePickerBtnEl.setAttribute("aria-expanded", "false");
  const isHidden = audioMenuEl.hidden;
  audioMenuEl.hidden = !isHidden;
  audioPickerBtnEl.setAttribute("aria-expanded", String(isHidden));
});

subtitlePickerBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  audioMenuEl.hidden = true;
  audioPickerBtnEl.setAttribute("aria-expanded", "false");
  const isHidden = subtitleMenuEl.hidden;
  subtitleMenuEl.hidden = !isHidden;
  subtitlePickerBtnEl.setAttribute("aria-expanded", String(isHidden));
});

document.addEventListener("click", () => {
  audioMenuEl.hidden = true;
  audioPickerBtnEl.setAttribute("aria-expanded", "false");
  subtitleMenuEl.hidden = true;
  subtitlePickerBtnEl.setAttribute("aria-expanded", "false");
});

void init();
