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
};

// ── Globals populated at runtime ──
let catalog: CatalogEntry[] = [];
let movies: Movie[] = [];
let movieCards: HTMLElement[] = [];
const movieById = new Map<string, Movie>();

function catalogToMovie(entry: CatalogEntry, index: number): Movie {
  const playlistName = (entry.multiAudio || entry.subtitles) ? "master.m3u8" : `${entry.hlsName}.m3u8`;
  return {
    id: entry.id,
    label: "",
    eyebrow: `FEATURE PRESENTATION · ${entry.year}`,
    titleHtml: `${entry.title}:<br /><em>${entry.subtitle}</em>`,
    playlist: `/${entry.outputPrefix}/${playlistName}`,
    posterLabel: `${entry.title}: ${entry.subtitle}`,
    rawTitle: entry.title,
    rawSubtitle: entry.subtitle,
    poster: entry.poster ? `${import.meta.env.BASE_URL}${entry.poster}` : undefined,
  };
}

// ── Card color palette (cycles for any number of movies) ──

const CARD_PALETTES = [
  { glow: "rgba(255, 211, 145, .42)", grad1: "#20120d", grad2: "#5a2418", grad3: "#0d1119", accent: "#bf8e63" },
  { glow: "rgba(255, 201, 103, .36)", grad1: "#071119", grad2: "#1e3c42", grad3: "#3b1d13", accent: "#63a6ae" },
  { glow: "rgba(186, 145, 255, .36)", grad1: "#120d20", grad2: "#3b1858", grad3: "#19110d", accent: "#9b6ebf" },
  { glow: "rgba(145, 255, 186, .36)", grad1: "#0d1912", grad2: "#185a3b", grad3: "#0d1119", accent: "#63bf8e" },
  { glow: "rgba(255, 145, 170, .36)", grad1: "#190d12", grad2: "#5a1830", grad3: "#110d19", accent: "#bf6378" },
  { glow: "rgba(145, 200, 255, .36)", grad1: "#0d1219", grad2: "#183a5a", grad3: "#19110d", accent: "#6396bf" },
];

// ── Render movie cards into the DOM ──



function renderMovieCards(): HTMLElement[] {
  const rail = document.querySelector<HTMLElement>(".movie-rail");
  if (!rail) throw new Error("Missing .movie-rail element.");

  rail.innerHTML = "";
  const cards: HTMLElement[] = [];

  movies.forEach((movie, index) => {
    const entry = catalog[index];
    const palette = CARD_PALETTES[index % CARD_PALETTES.length];

    const article = document.createElement("article");
    article.className = `movie-card`;
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
        <span class="poster-shine" aria-hidden="true"></span>
        <span class="poster-meta">${entry.year}</span>
        <strong>${entry.title}</strong>
        <em>${entry.subtitle}</em>
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

// DOM elements will be selected synchronously below.

const video = document.querySelector<HTMLVideoElement>("#player");
const errorPanel = document.querySelector<HTMLElement>("#player-error");
const errorTitle = document.querySelector<HTMLElement>("#player-error-title");
const errorDetail = document.querySelector<HTMLElement>("#player-error-detail");
const sessionState = document.querySelector<HTMLElement>("#session-state");
const title = document.querySelector<HTMLElement>("#title");
const eyebrowEl = document.querySelector<HTMLElement>("#movie-eyebrow");
const library = document.querySelector<HTMLElement>(".library");
const expandedPlayer = document.querySelector<HTMLElement>("#expanded-player");
const backdrop = document.querySelector<HTMLElement>("#player-backdrop");
const closeBtn = document.querySelector<HTMLElement>("#close-player");
const audioPicker = document.querySelector<HTMLElement>("#audio-picker");
const audioPickerBtn = document.querySelector<HTMLButtonElement>("#audio-picker-btn");
const audioCurrent = document.querySelector<HTMLElement>("#audio-current");
const audioMenu = document.querySelector<HTMLElement>("#audio-menu");
const subtitlePicker = document.querySelector<HTMLElement>("#subtitle-picker");
const subtitlePickerBtn = document.querySelector<HTMLButtonElement>("#subtitle-picker-btn");
const subtitleCurrent = document.querySelector<HTMLElement>("#subtitle-current");
const subtitleMenu = document.querySelector<HTMLElement>("#subtitle-menu");
const logoutBtn = document.querySelector<HTMLElement>("#logout");

if (!video || !errorPanel || !errorTitle || !errorDetail || !sessionState || !title || !eyebrowEl || !library || !expandedPlayer || !backdrop || !closeBtn || !audioPicker || !audioPickerBtn || !audioCurrent || !audioMenu || !subtitlePicker || !subtitlePickerBtn || !subtitleCurrent || !subtitleMenu || !logoutBtn) {
  throw new Error("The viewer page is missing required elements.");
}
const player = video;
const accessErrorPanel = errorPanel;
const accessErrorTitle = errorTitle;
const accessErrorDetail = errorDetail;
const sessionLabel = sessionState;
const movieTitle = title;
const movieEyebrow = eyebrowEl;
const libraryPanel = library;
const playerStage = expandedPlayer;
const playerBackdrop = backdrop;
const closeButton = closeBtn;
const audioPickerEl = audioPicker;
const audioPickerBtnEl = audioPickerBtn;
const audioCurrentEl = audioCurrent;
const audioMenuEl = audioMenu;
const subtitlePickerEl = subtitlePicker;
const subtitlePickerBtnEl = subtitlePickerBtn;
const subtitleCurrentEl = subtitleCurrent;
const subtitleMenuEl = subtitleMenu;
const logoutBtnEl = logoutBtn;
let activeMovie: Movie;
let activeHls: Hls | undefined;
let isPlayerOpen = false;

// ── Auth & API Configuration ──
const API_URL = window.location.origin.includes("localhost") ? "http://localhost:8000" : "";

function getHeaders() {
  return {
    "Content-Type": "application/json",
  };
}

function showAccessError(
  detail = "Your signed viewing session may have expired.",
  title = "Playback could not continue.",
) {
  accessErrorPanel.hidden = false;
  accessErrorTitle.textContent = title;
  accessErrorDetail.textContent = detail;
  sessionLabel.textContent = "Session expired";
}

function hideAccessError() {
  accessErrorPanel.hidden = true;
  accessErrorTitle.textContent = "Playback could not continue.";
  accessErrorDetail.textContent = "A stream diagnostic will appear here.";
}

function applyMovie(movie: Movie) {
  activeMovie = movie;
  document.body.dataset.activeMovie = movie.id;
  libraryPanel.classList.add("has-selection");
  playerStage.dataset.movieId = movie.id;
  movieTitle.innerHTML = movie.titleHtml;
  movieEyebrow.textContent = movie.eyebrow;
  player.setAttribute("aria-label", movie.posterLabel);
  for (const card of movieCards) {
    const selected = card.dataset.movieId === movie.id;
    card.classList.toggle("is-active", selected);
    card.querySelector(".movie-select")?.setAttribute("aria-pressed", String(selected));
    card.querySelector(".play-pill")!.textContent = selected ? "Playing" : "Play";
  }

  const url = new URL(window.location.href);
  url.searchParams.set("movie", movie.id);
  window.history.replaceState(null, "", url);
}

function openPlayer() {
  isPlayerOpen = true;
  document.body.classList.add("player-open");
  playerBackdrop.classList.add("is-visible");
  playerStage.classList.remove("is-closing");
  playerStage.classList.add("is-open");
  playerStage.classList.add("is-visible");
}

function closePlayer() {
  if (!isPlayerOpen) return;
  isPlayerOpen = false;

  // Start closing animation
  playerStage.classList.add("is-closing");
  playerStage.classList.remove("is-open");
  playerStage.classList.remove("is-visible");
  playerBackdrop.classList.remove("is-visible");
  document.body.classList.remove("player-open");

  // Stop playback
  resetPlayer();
  renderContinueWatching();
  libraryPanel.classList.remove("has-selection");
  for (const card of movieCards) {
    card.classList.remove("is-active");
    card.querySelector(".movie-select")?.setAttribute("aria-pressed", "false");
    card.querySelector(".play-pill")!.textContent = "Play";
  }

  // Remove closing class after animation completes
  setTimeout(() => {
    playerStage.classList.remove("is-closing");
  }, 350);
}

async function ensureAuthorized(movie: Movie) {
  const response = await fetch(movie.playlist, { method: "HEAD", credentials: "same-origin" });
  if (response.status === 403) {
    throw new Error("Access Denied: Your signed viewing session has expired. Please click 'Sign in again' below to refresh your access.");
  }
  if (!response.ok) {
    throw new Error(`Playlist availability check failed (${response.status}).`);
  }
  return true;
}

function getLanguageName(langCode: string): string {
  const customMap: Record<string, string> = {
    tel: "Telugu",
    hin: "Hindi",
    tam: "Tamil",
    mal: "Malayalam",
    kan: "Kannada",
    eng: "English"
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
      if (track.id === currentTrack.id) {
        li.classList.add("is-selected");
      }
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
function setupNativeAudioTracks(videoEl: HTMLVideoElement) {
  const tracks = (videoEl as any).audioTracks;
  if (tracks && tracks.length > 1) {
    audioPickerEl.hidden = false;
    audioMenuEl.innerHTML = "";
    
    let activeTrack: any = null;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].enabled) {
        activeTrack = tracks[i];
        break;
      }
    }
    if (!activeTrack) activeTrack = tracks[0];
    
    audioCurrentEl.textContent = getLanguageName(activeTrack.language || activeTrack.label || "unknown");
    
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const li = document.createElement("li");
      li.className = "audio-picker-item";
      if (track.enabled) {
        li.classList.add("is-selected");
      }
      li.textContent = getLanguageName(track.language || track.label || `Track ${i+1}`);
      li.setAttribute("role", "option");
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        for (let j = 0; j < tracks.length; j++) {
          tracks[j].enabled = (i === j);
        }
        audioCurrentEl.textContent = getLanguageName(track.language || track.label || `Track ${i+1}`);
        audioMenuEl.hidden = true;
        audioPickerBtnEl.setAttribute("aria-expanded", "false");
        
        audioMenuEl.querySelectorAll(".audio-picker-item").forEach((item, idx) => {
          item.classList.toggle("is-selected", idx === i);
        });
      });
      audioMenuEl.appendChild(li);
    }
  } else {
    audioPickerEl.hidden = true;
  }
}

function setupHlsSubtitles(hls: Hls) {
  const tracks = hls.subtitleTracks;
  if (tracks.length > 0) {
    subtitlePickerEl.hidden = false;
    subtitleMenuEl.innerHTML = "";
    
    // Add "Off" option
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
    
    // Add subtitle language tracks
    tracks.forEach((track, index) => {
      const li = document.createElement("li");
      li.className = "subtitle-picker-item";
      
      const isSelected = hls.subtitleTrack === index;
      if (isSelected) {
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

function setupNativeSubtitles(videoEl: HTMLVideoElement) {
  const tracks = videoEl.textTracks;
  const subTracks: TextTrack[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].kind === "subtitles" || tracks[i].kind === "captions") {
      subTracks.push(tracks[i]);
    }
  }

  if (subTracks.length > 0) {
    subtitlePickerEl.hidden = false;
    subtitleMenuEl.innerHTML = "";
    
    // Add "Off" option
    const offLi = document.createElement("li");
    offLi.className = "subtitle-picker-item";
    
    let anyShowing = false;
    for (let i = 0; i < subTracks.length; i++) {
      if (subTracks[i].mode === "showing") {
        anyShowing = true;
        break;
      }
    }
    
    if (!anyShowing) {
      offLi.classList.add("is-selected");
      subtitleCurrentEl.textContent = "Subtitles: Off";
    } else {
      subtitleCurrentEl.textContent = "Subtitles";
    }
    
    offLi.textContent = "Off";
    offLi.setAttribute("role", "option");
    offLi.addEventListener("click", (e) => {
      e.stopPropagation();
      for (let j = 0; j < subTracks.length; j++) {
        subTracks[j].mode = "disabled";
      }
      subtitleCurrentEl.textContent = "Subtitles: Off";
      subtitleMenuEl.hidden = true;
      subtitlePickerBtnEl.setAttribute("aria-expanded", "false");
      
      subtitleMenuEl.querySelectorAll(".subtitle-picker-item").forEach((item, idx) => {
        item.classList.toggle("is-selected", idx === 0);
      });
    });
    subtitleMenuEl.appendChild(offLi);
    
    // Add subtitle tracks
    subTracks.forEach((track, index) => {
      const li = document.createElement("li");
      li.className = "subtitle-picker-item";
      
      if (track.mode === "showing") {
        li.classList.add("is-selected");
        subtitleCurrentEl.textContent = `Subtitles: ${getLanguageName(track.language || track.label || `Track ${index+1}`)}`;
      }
      
      li.textContent = getLanguageName(track.language || track.label || `Track ${index+1}`);
      li.setAttribute("role", "option");
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        for (let j = 0; j < subTracks.length; j++) {
          subTracks[j].mode = (index === j) ? "showing" : "disabled";
        }
        subtitleCurrentEl.textContent = `Subtitles: ${getLanguageName(track.language || track.label || `Track ${index+1}`)}`;
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

function resetPlayer() {
  activeHls?.destroy();
  activeHls = undefined;
  player.removeAttribute("src");
  player.load();
  audioPickerEl.hidden = true;
  audioMenuEl.hidden = true;
  audioPickerBtnEl.setAttribute("aria-expanded", "false");
  subtitlePickerEl.hidden = true;
  subtitleMenuEl.hidden = true;
  subtitlePickerBtnEl.setAttribute("aria-expanded", "false");
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    const remM = m % 60;
    return `${h}h ${remM}m`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
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
    console.warn("Failed to save progress to API:", err);
  }
}

let lastSavedTime = 0;
let lastSavedMovieId = "";

player.addEventListener("playing", () => {
  hideAccessError();
});

player.addEventListener("play", () => {
  hideAccessError();
});

player.addEventListener("timeupdate", () => {
  const currentTime = player.currentTime;
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

async function loadPlayer(movie: Movie) {
  resetPlayer();

  let startSeconds = 0;
  
  // Check localStorage first for fast resume
  const localSaved = localStorage.getItem(`hls_progress_${movie.id}`);
  if (localSaved) {
    const parsed = parseFloat(localSaved);
    if (!isNaN(parsed) && parsed > 0) {
      startSeconds = parsed;
    }
  }

  // Fallback/sync with API
  if (startSeconds === 0) {
    try {
      const progressRes = await fetch(`${API_URL}/api/progress/${movie.id}`, { headers: getHeaders() });
      if (progressRes.ok) {
        const progressData = await progressRes.json();
        if (progressData.seconds > 0) {
          startSeconds = progressData.seconds;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch playback progress from API:", e);
    }
  }

  if (startSeconds > 0) {
    console.log(`Resuming ${movie.posterLabel} at ${startSeconds.toFixed(1)}s`);
  }

  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup(xhr) {
        xhr.withCredentials = true;
      },
    });
    activeHls = hls;
    hls.loadSource(movie.playlist);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hideAccessError();
      setupHlsAudioTracks(hls);
      setupHlsSubtitles(hls);
      if (startSeconds > 0) {
        player.currentTime = startSeconds;
      }
      player.play().catch((e) => console.log("Autoplay prevented:", e));
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      setupHlsAudioTracks(hls);
    });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      setupHlsSubtitles(hls);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;

      if (data.response?.code === 403) {
        showAccessError(
          "Your viewing session has expired. Please click 'Sign in again' below to refresh your access.",
          "Access Denied (403)"
        );
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn("Fatal media error encountered, attempting recovery...", data);
        hls.recoverMediaError();
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        console.warn("Fatal network error encountered, attempting reload...", data);
        hls.startLoad();
        return;
      }

      console.error("Unrecoverable HLS error", data);
      showAccessError(
        `Unable to continue playback (${data.details}).`,
        "Playback Error"
      );
    });
    return;
  }

  if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = movie.playlist;
    if (startSeconds > 0) {
      player.currentTime = startSeconds;
    }
    player.play().catch((e) => console.log("Autoplay prevented:", e));
    return;
  }

  showAccessError("This browser does not support HLS playback.", "HLS is not supported");
}

async function selectMovie(movie: Movie) {
  hideAccessError();
  sessionLabel.textContent = "Loading stream...";
  applyMovie(movie);
  openPlayer();
  try {
    await loadPlayer(movie);
    sessionLabel.textContent = "Secure session active";
  } catch (error) {
    showAccessError(error instanceof Error ? error.message : "Unable to load selected movie.");
  }
}

// ── Card click handlers ──
function setupCardClickHandlers() {
  for (const card of movieCards) {
    card.querySelector(".movie-select")?.addEventListener("click", () => {
      const movie = movieById.get(card.dataset.movieId ?? "");
      if (movie) void selectMovie(movie);
    });
  }
}

// ── Debounce Utility ──
function debounce<T extends (...args: any[]) => void>(func: T, delayMs: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delayMs);
  }) as T;
}

// ── Search Handler ──
function setupSearchHandler() {
  const searchInput = document.querySelector<HTMLInputElement>("#movie-search");
  const noResultsEl = document.querySelector<HTMLElement>("#no-search-results");
  if (!searchInput) return;

  const handleSearch = debounce(() => {
    const query = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;

    for (const card of movieCards) {
      const movieId = card.dataset.movieId ?? "";
      const catalogEntry = catalog.find((c) => c.id === movieId);
      if (!catalogEntry) continue;

      const titleMatch = catalogEntry.title.toLowerCase().includes(query);
      const subtitleMatch = catalogEntry.subtitle.toLowerCase().includes(query);
      const yearMatch = catalogEntry.year.toString().includes(query);
      const idMatch = catalogEntry.id.toLowerCase().includes(query);

      const isMatch = !query || titleMatch || subtitleMatch || yearMatch || idMatch;
      card.style.display = isMatch ? "" : "none";
      if (isMatch) visibleCount++;
    }

    if (noResultsEl) {
      noResultsEl.hidden = visibleCount > 0;
    }
  }, 150);

  searchInput.addEventListener("input", handleSearch);
}

// ── App Initialization ──
async function init() {
  try {
    sessionLabel.textContent = "Checking session…";

    const response = await fetch(`${import.meta.env.BASE_URL}movies.json`);
    if (!response.ok) throw new Error("Failed to load catalog.");
    catalog = await response.json() as CatalogEntry[];
    movies = catalog.map(catalogToMovie);
    movies.forEach((movie) => movieById.set(movie.id, movie));

    movieCards = renderMovieCards();
    setupCardClickHandlers();
    setupSearchHandler();
    renderContinueWatching();

    if (movies.length > 0) {
      activeMovie = movies[0];
    }
    sessionLabel.textContent = "Private cinema ready";
  } catch (error) {
    console.error("Initialization failed:", error);
    showAccessError(
      error instanceof Error ? error.message : "Unable to load movie library.",
      "Library Load Failed"
    );
  }
}

// ── Close handlers ──
closeButton.addEventListener("click", closePlayer);
playerBackdrop.addEventListener("click", closePlayer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isPlayerOpen) {
    closePlayer();
  }
});

// ── Audio & Subtitle picker toggles ──
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

// Setup native tracks detection for Safari fallback
player.addEventListener("loadedmetadata", () => {
  if (!activeHls) {
    setupNativeAudioTracks(player);
    setupNativeSubtitles(player);
  }
});

// Start initialization
void init();
