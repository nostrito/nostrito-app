import React, { useEffect } from "react";
import { BrowserRouter, Routes, Route, Outlet, Navigate, useNavigate, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { AppProvider, useAppContext } from "./context/AppContext";
import { ProfileProvider } from "./context/ProfileContext";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { initMediaViewer } from "./utils/media";

// Lazy load screens
import { Dashboard } from "./screens/Dashboard";
import { Feed } from "./screens/Feed";
import { Dms } from "./screens/Dms";
import { Wot } from "./screens/Wot";
import { Storage } from "./screens/Storage";
import { Settings } from "./screens/Settings";
import { Wizard } from "./screens/Wizard";
import { ProfileView } from "./screens/ProfileView";
import { NoteDetail } from "./screens/NoteDetail";
import { StorageOwnEvents } from "./screens/StorageOwnEvents";
import { StorageTrackedProfiles } from "./screens/StorageTrackedProfiles";
import { StorageWotProfiles } from "./screens/StorageWotProfiles";

const SCREEN_LABELS: Record<string, string> = {
  "/": "Dashboard",
  "/feed": "Feed",
  "/dms": "DMs",
  "/wot": "WoT",
  "/storage": "Storage",
  "/storage/own-events": "Storage / Own Events",
  "/storage/tracked-profiles": "Storage / Tracked Profiles",
  "/storage/wot-profiles": "Storage / WoT Profiles",
  "/settings": "Settings",
};

const AppShell: React.FC = () => {
  const { appStatus } = useAppContext();
  const location = useLocation();

  const label = SCREEN_LABELS[location.pathname] || "nostrito";
  const relayUrl = appStatus?.relay_running ? `wss://localhost:${appStatus.relay_port}` : null;
  const titleText = relayUrl && location.pathname === "/"
    ? `nostrito — ${relayUrl}`
    : `nostrito — ${label}`;

  return (
    <>
      <Titlebar title={titleText} />
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </>
  );
};

const AppRoutes: React.FC = () => {
  const { isInitialized, setInitialized } = useAppContext();
  const navigate = useNavigate();

  useEffect(() => {
    initMediaViewer();

    const unlistenPromise = listen("app:reset", () => {
      localStorage.removeItem("nostrito_initialized");
      localStorage.removeItem("nostrito_config");
      setInitialized(false);
      navigate("/wizard");
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [navigate, setInitialized]);

  // Click delegation for [data-pubkey], [data-note-id], [data-naddr] elements
  useEffect(() => {
    const handler = async (e: MouseEvent) => {
      const el = e.target as HTMLElement;

      // Profile links
      const pubkeyEl = el.closest("[data-pubkey]") as HTMLElement | null;
      if (pubkeyEl) {
        const pubkey = pubkeyEl.dataset.pubkey;
        if (pubkey) navigate(`/profile/${pubkey}`);
        return;
      }

      // Note/nevent links
      const noteEl = el.closest("[data-note-id]") as HTMLElement | null;
      if (noteEl) {
        const noteId = noteEl.dataset.noteId;
        if (noteId) navigate(`/note/${noteId}`);
        return;
      }

      // naddr links (addressable events)
      const naddrEl = el.closest("[data-naddr]") as HTMLElement | null;
      if (naddrEl) {
        try {
          const data = JSON.parse(naddrEl.dataset.naddr || "{}");
          const { invoke } = await import("@tauri-apps/api/core");
          const ev = await invoke<{ id: string } | null>("get_addressable_event", {
            kind: data.kind,
            pubkey: data.pubkey,
            dTag: data.dTag,
          });
          if (ev) {
            navigate(`/note/${ev.id}`);
          }
        } catch (err) {
          console.error("[naddr] Failed to resolve addressable event:", err);
        }
        return;
      }

      // Hashtag links → navigate to feed with search query
      const hashtagEl = el.closest("[data-hashtag]") as HTMLElement | null;
      if (hashtagEl) {
        const tag = hashtagEl.dataset.hashtag;
        if (tag) navigate(`/feed?q=${encodeURIComponent("#" + tag)}`);
        return;
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [navigate]);

  return (
    <Routes>
      <Route path="/wizard" element={isInitialized ? <Navigate to="/" replace /> : <Wizard />} />
      <Route element={isInitialized ? <AppShell /> : <Navigate to="/wizard" replace />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/feed" element={<Feed />} />
        <Route path="/dms" element={<Dms />} />
        <Route path="/wot" element={<Wot />} />
        <Route path="/storage" element={<Storage />} />
        <Route path="/storage/own-events" element={<StorageOwnEvents />} />
        <Route path="/storage/tracked-profiles" element={<StorageTrackedProfiles />} />
        <Route path="/storage/wot-profiles" element={<StorageWotProfiles />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/profile/:pubkey" element={<ProfileView />} />
        <Route path="/note/:noteId" element={<NoteDetail />} />
      </Route>
    </Routes>
  );
};

export const App: React.FC = () => (
  <AppProvider>
    <ProfileProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ProfileProvider>
  </AppProvider>
);
