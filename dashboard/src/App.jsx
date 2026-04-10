import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ServerDetail from './pages/ServerDetail.jsx';
import ProcessDetail from './pages/ProcessDetail.jsx';
import Alerts from './pages/Alerts.jsx';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const WsContext = createContext(null);
export const useWs = () => useContext(WsContext);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/auth/me')
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    setUser(data.user);
  };

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

function Navbar() {
  const { user, logout } = useAuth();
  const ws = useWs();

  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand">
        <span className="dot" />
        PM2 Monitor
      </Link>
      <div className="navbar-right">
        <Link to="/alerts" className="btn btn-sm">Alerts</Link>
        <span className="navbar-user">
          {ws?.connected ? '🟢' : '🔴'} {user?.email}
        </span>
        <button className="btn btn-sm" onClick={logout}>Logout</button>
      </div>
    </nav>
  );
}

function ProtectedLayout() {
  const { user } = useAuth();
  const [wsMessages, setWsMessages] = useState([]);

  const handleWsMessage = useCallback((msg) => {
    // Dispatch custom event so any component can listen
    window.dispatchEvent(new CustomEvent('ws-message', { detail: msg }));
  }, []);

  const ws = useWebSocket(handleWsMessage);

  if (!user) return <Navigate to="/login" />;

  return (
    <WsContext.Provider value={ws}>
      <div className="app-layout">
        <Navbar />
        <div className="app-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/servers/:id" element={<ServerDetail />} />
            <Route path="/processes/:id" element={<ProcessDetail />} />
            <Route path="/alerts" element={<Alerts />} />
          </Routes>
        </div>
      </div>
    </WsContext.Provider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<ProtectedLayout />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
