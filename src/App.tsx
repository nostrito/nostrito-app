import React, { useEffect } from "react";
import { BrowserRouter, Routes, Route, Outlet, Navigate, useNavigate, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { AppProvider, useAppContext } from "./context/AppContext";
import { ProfileProvider } from "./context/ProfileContext";
import { SigningProvider } from "./context/SigningContext";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { initMediaViewer, closeMediaViewer } from "./utils/media";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, color: "#ccc", fontFamily: "sans-serif" }}>
          <h2 style={{ color: "#fff" }}>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7, fontSize: 13 }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.hash = "/"; window.location.reload(); }}
            style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer", background: "#333", color: "#fff", border: "1px solid #555", borderRadius: 4 }}
          >
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Lazy load screens
import { Feed } from "./screens/Feed";
import { Bookmarks } from "./screens/Bookmarks";
import { Dms } from "./screens/Dms";
import { Wot } from "./screens/Wot";
import { Settings } from "./screens/Settings";
import { SettingsAnalytics } from "./screens/SettingsAnalytics";
import { Wizard } from "./screens/Wizard";
import { ProfileView } from "./screens/ProfileView";
import { NoteDetail } from "./screens/NoteDetail";
import { StorageOwnEvents } from "./screens/StorageOwnEvents";
import { StorageTrackedProfiles } from "./screens/StorageTrackedProfiles";
import { StorageWotProfiles } from "./screens/StorageWotProfiles";
import { Gallery } from "./screens/Gallery";
import { Wallet } from "./screens/Wallet";

const SCREEN_LABELS: Record<string, string> = {
  "/": "feed",
  "/bookmarks": "bookmarks",
  "/dms": "messages",
  "/gallery": "gallery",
  "/wallet": "wallet",
  "/settings": "settings",
  "/settings/analytics": "settings / analytics",
  "/settings/analytics/own-events": "analytics / own events",
  "/settings/analytics/tracked-profiles": "analytics / tracked profiles",
  "/settings/analytics/wot-profiles": "analytics / wot profiles",
  "/settings/analytics/wot": "analytics / wot explorer",
};

const AppShell: React.FC = () => {
  const { appStatus } = useAppContext();
  const location = useLocation();

  const label = SCREEN_LABELS[location.pathname] || "nostrito";
  const relayUrl = appStatus?.relay_running ? `wss://localhost:${appStatus.relay_port}` : null;
  const titleText = relayUrl && location.pathname === "/settings/analytics"
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

  // Close media viewer overlay on route change
  const location = useLocation();
  useEffect(() => {
    console.log("[app] route changed to:", location.pathname);
    closeMediaViewer();
  }, [location.pathname]);

  // Click delegation for [data-pubkey], [data-note-id], [data-naddr] elements
  useEffect(() => {
    const handler = async (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      console.log("[app:click-delegation] click on:", el.tagName, el.className, "closest event-card:", !!el.closest(".event-card"));

      // Profile links
      const pubkeyEl = el.closest("[data-pubkey]") as HTMLElement | null;
      if (pubkeyEl) {
        const pubkey = pubkeyEl.dataset.pubkey;
        console.log("[app:click-delegation] → profile navigation:", pubkey?.slice(0, 12));
        if (pubkey) navigate(`/profile/${pubkey}`);
        return;
      }

      // Note/nevent links
      const noteEl = el.closest("[data-note-id]") as HTMLElement | null;
      if (noteEl) {
        const noteId = noteEl.dataset.noteId;
        console.log("[app:click-delegation] → note navigation:", noteId?.slice(0, 12));
        if (noteId) navigate(`/note/${noteId}`);
        return;
      }

      // naddr links (addressable events)
      const naddrEl = el.closest("[data-naddr]") as HTMLElement | null;
      if (naddrEl) {
        try {
          const data = JSON.parse(naddrEl.dataset.naddr || "{}");
          const { invoke } = await import("@tauri-apps/api/core");
          let ev = await invoke<{ id: string } | null>("get_addressable_event", {
            kind: data.kind,
            pubkey: data.pubkey,
            dTag: data.dTag,
          });
          if (ev) {
            navigate(`/note/${ev.id}`);
          } else {
            // Not in local DB — fetch from relays
            const evId = await invoke<string | null>("fetch_addressable_event_from_relays", {
              kind: data.kind,
              pubkey: data.pubkey,
              dTag: data.dTag,
            });
            if (evId) navigate(`/note/${evId}`);
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
        if (tag) navigate(`/?q=${encodeURIComponent("#" + tag)}`);
        return;
      }
    };
    document.addEventListener("click", handler);

    // Media viewer "View Event" navigation
    const navHandler = (e: Event) => {
      const { noteId } = (e as CustomEvent).detail || {};
      if (noteId) navigate(`/note/${noteId}`);
    };
    window.addEventListener("navigate-to-note", navHandler);

    return () => {
      document.removeEventListener("click", handler);
      window.removeEventListener("navigate-to-note", navHandler);
    };
  }, [navigate]);

  return (
    <Routes>
      <Route path="/wizard" element={isInitialized ? <Navigate to="/" replace /> : <Wizard />} />
      <Route element={isInitialized ? <AppShell /> : <Navigate to="/wizard" replace />}>
        <Route path="/" element={<Feed />} />
        <Route path="/bookmarks" element={<Bookmarks />} />
        <Route path="/dms" element={<Dms />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/analytics" element={<SettingsAnalytics />} />
        <Route path="/settings/analytics/own-events" element={<StorageOwnEvents />} />
        <Route path="/settings/analytics/tracked-profiles" element={<StorageTrackedProfiles />} />
        <Route path="/settings/analytics/wot-profiles" element={<StorageWotProfiles />} />
        <Route path="/settings/analytics/wot" element={<Wot />} />
        <Route path="/profile/:pubkey" element={<ProfileView />} />
        <Route path="/note/:noteId" element={<NoteDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
};

export const App: React.FC = () => (
  <ErrorBoundary>
    <AppProvider>
      <SigningProvider>
        <ProfileProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </ProfileProvider>
      </SigningProvider>
    </AppProvider>
  </ErrorBoundary>
);
