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
import { MyMedia } from "./screens/MyMedia";
import { Wizard } from "./screens/Wizard";
import { ProfileView } from "./screens/ProfileView";

const SCREEN_LABELS: Record<string, string> = {
  "/": "Dashboard",
  "/feed": "Feed",
  "/dms": "DMs",
  "/wot": "WoT",
  "/storage": "Storage",
  "/settings": "Settings",
  "/my-media": "My Media",
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

  // Pubkey click delegation for [data-pubkey] elements
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest("[data-pubkey]") as HTMLElement | null;
      if (!target) return;
      const pubkey = target.dataset.pubkey;
      if (pubkey) navigate(`/profile/${pubkey}`);
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
        <Route path="/settings" element={<Settings />} />
        <Route path="/my-media" element={<MyMedia />} />
        <Route path="/profile/:pubkey" element={<ProfileView />} />
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
