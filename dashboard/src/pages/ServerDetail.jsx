import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, formatBytes, formatUptime } from '../api.js';
import { useAuth } from '../App.jsx';

export default function ServerDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [server, setServer] = useState(null);
  const [processes, setProcesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddProcess, setShowAddProcess] = useState(false);
  const [editingProcess, setEditingProcess] = useState(null);
  const [liveMetrics, setLiveMetrics] = useState({});
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);

  // Form state
  const [form, setForm] = useState({ name: '', command: '', cwd: '', autorestart: true, max_restarts: 10, managed_by: 'external', match_pattern: '', env_vars_text: '' });

  const fetchData = useCallback(async () => {
    try {
      const [serverData, processData] = await Promise.all([
        api.get(`/api/servers/${id}`),
        api.get(`/api/servers/${id}/processes`),
      ]);
      setServer(serverData.server);
      setProcesses(processData.processes);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Live metrics via WS
  useEffect(() => {
    const handler = (e) => {
      const msg = e.detail;
      if (msg.type === 'metrics_tick') {
        setLiveMetrics(prev => ({ ...prev, [msg.process_id]: { cpu: msg.cpu, mem: msg.mem } }));
      }
      if (msg.type === 'process_update' && msg.process) {
        setProcesses(prev => prev.map(p => p.id === msg.process.id ? msg.process : p));
      }
    };
    window.addEventListener('ws-message', handler);
    return () => window.removeEventListener('ws-message', handler);
  }, []);

  const handleAction = async (processId, action) => {
    const key = `${processId}:${action}`;
    if (actionLoading) return;
    setActionLoading(key);
    try {
      await api.post(`/api/processes/${processId}/${action}`);
      setToast({ message: `${action.charAt(0).toUpperCase() + action.slice(1)} sent`, type: 'success' });
      setTimeout(() => {
        fetchData();
        setActionLoading(null);
      }, 1500);
      setTimeout(() => setToast(null), 3500);
    } catch (err) {
      setToast({ message: `Failed: ${err.message}`, type: 'error' });
      setActionLoading(null);
      setTimeout(() => setToast(null), 3500);
    }
  };

  const handleAddProcess = handleSubmitProcess;

  const handleDeleteProcess = async (processId, name) => {
    if (!confirm(`Delete process "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/processes/${processId}`);
      fetchData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleEditClick = (proc) => {
    setEditingProcess(proc);
    // Convert env_vars JSON back to KEY=value text
    let envText = '';
    if (proc.env_vars) {
      try {
        const parsed = typeof proc.env_vars === 'string' ? JSON.parse(proc.env_vars) : proc.env_vars;
        envText = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('\n');
      } catch {}
    }
    setForm({
      name: proc.name || '',
      command: proc.command || '',
      cwd: proc.cwd || '',
      autorestart: !!proc.autorestart,
      max_restarts: proc.max_restarts || 10,
      managed_by: proc.managed_by || 'agent',
      match_pattern: proc.match_pattern || '',
      env_vars_text: envText,
    });
    setShowAddProcess(true);
  };

  const handleSubmitProcess = async (e) => {
    e.preventDefault();
    try {
      // Parse KEY=value lines into an object
      const envVars = {};
      if (form.env_vars_text) {
        form.env_vars_text.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            envVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
          }
        });
      }

      const payload = {
        name: form.name,
        command: form.command,
        cwd: form.cwd,
        autorestart: form.autorestart,
        max_restarts: form.max_restarts,
        managed_by: form.managed_by,
        match_pattern: form.match_pattern,
        env_vars: Object.keys(envVars).length > 0 ? envVars : null,
      };

      if (editingProcess) {
        await api.patch(`/api/processes/${editingProcess.id}`, payload);
      } else {
        await api.post(`/api/servers/${id}/processes`, payload);
      }
      setShowAddProcess(false);
      setEditingProcess(null);
      setForm({ name: '', command: '', cwd: '', autorestart: true, max_restarts: 10, managed_by: 'external', match_pattern: '', env_vars_text: '' });
      fetchData();
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading) return <div className="empty-state"><div className="empty-state-text">Loading...</div></div>;
  if (!server) return <div className="empty-state"><div className="empty-state-text">Server not found</div></div>;

  return (
    <div className="fade-in">
      <div className="page-breadcrumb">
        <Link to="/">Servers</Link> / {server.name}
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {server.name}
            <span className={`badge badge-${server.status}`}>{server.status}</span>
          </h1>
          {server.hostname && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
              {server.hostname} {server.ip_address ? `(${server.ip_address})` : ''}
              {server.os_info ? ` • ${server.os_info}` : ''}
              {server.agent_version ? ` • agent v${server.agent_version}` : ''}
            </div>
          )}
        </div>
        {user?.role === 'admin' && (
          <button className="btn btn-primary" onClick={() => setShowAddProcess(true)}>
            + Add Process
          </button>
        )}
      </div>

      {/* Process table */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Processes ({processes.length})</span>
        </div>

        {processes.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-state-text">No processes configured. Add one to get started.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>PID</th>
                  <th>Restarts</th>
                  <th>Uptime</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {processes.map(proc => {
                  const live = liveMetrics[proc.id];
                  const cpu = live?.cpu ?? proc.latest_cpu;
                  const mem = live?.mem ?? proc.latest_mem;
                  return (
                    <tr key={proc.id}>
                      <td>
                        <Link to={`/processes/${proc.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                          {proc.name}
                        </Link>
                        <div className="mono" style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                          {proc.command?.length > 50 ? proc.command.slice(0, 50) + '...' : proc.command}
                        </div>
                      </td>
                      <td><span className={`badge badge-${proc.status}`}>{proc.status}</span></td>
                      <td>
                        <span className="mono" style={{ fontSize: 11, color: proc.managed_by === 'external' ? 'var(--cyan)' : 'var(--text-muted)' }}>
                          {proc.managed_by === 'external' ? 'external' : 'managed'}
                        </span>
                      </td>
                      <td className="mono">{cpu != null ? `${Number(cpu).toFixed(1)}%` : '-'}</td>
                      <td className="mono">{mem != null ? formatBytes(Number(mem)) : '-'}</td>
                      <td className="mono">{proc.pid || '-'}</td>
                      <td className="mono" style={{ color: proc.restart_count > 5 ? 'var(--yellow)' : 'inherit' }}>
                        {proc.restart_count}
                      </td>
                      <td className="mono">{proc.status === 'running' ? formatUptime(proc.uptime_started_at) : '-'}</td>
                      <td>
                        <div className="btn-group">
                          {proc.managed_by !== 'external' && proc.status !== 'running' && (
                            <button className="btn btn-sm btn-success"
                              onClick={() => handleAction(proc.id, 'start')}
                              disabled={actionLoading === `${proc.id}:start`}>
                              {actionLoading === `${proc.id}:start` ? '⟳' : 'Start'}
                            </button>
                          )}
                          {proc.managed_by !== 'external' && proc.status === 'running' && (
                            <>
                              <button className="btn btn-sm"
                                onClick={() => handleAction(proc.id, 'restart')}
                                disabled={actionLoading === `${proc.id}:restart`}>
                                {actionLoading === `${proc.id}:restart` ? '⟳' : 'Restart'}
                              </button>
                              <button className="btn btn-sm btn-danger"
                                onClick={() => handleAction(proc.id, 'stop')}
                                disabled={actionLoading === `${proc.id}:stop`}>
                                {actionLoading === `${proc.id}:stop` ? '⟳' : 'Stop'}
                              </button>
                            </>
                          )}
                          {user?.role === 'admin' && (
                            <>
                              <button className="btn btn-sm" onClick={() => handleEditClick(proc)} title="Edit">Edit</button>
                              <button className="btn btn-sm btn-icon" onClick={() => handleDeleteProcess(proc.id, proc.name)} title="Delete">🗑</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add/Edit Process Modal */}
      {showAddProcess && (
        <div className="modal-overlay" onClick={() => { setShowAddProcess(false); setEditingProcess(null); }}>
          <div className="modal fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{editingProcess ? `Edit Process: ${editingProcess.name}` : 'Add Process'}</div>
            <form onSubmit={handleSubmitProcess}>
              <div className="form-group">
                <label className="form-label">Mode</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button"
                    className={`btn btn-sm ${form.managed_by === 'external' ? 'btn-primary' : ''}`}
                    onClick={() => setForm({ ...form, managed_by: 'external' })}>
                    Monitor Only (external)
                  </button>
                  <button type="button"
                    className={`btn btn-sm ${form.managed_by === 'agent' ? 'btn-primary' : ''}`}
                    onClick={() => setForm({ ...form, managed_by: 'agent' })}>
                    Fully Managed
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {form.managed_by === 'external'
                    ? 'Watches an existing process (e.g. PM2-managed). Won\'t start/stop it.'
                    : 'Agent spawns and manages the process lifecycle.'}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Process Name</label>
                <input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="flarepublic-live" required autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">{form.managed_by === 'external' ? 'Command (for reference)' : 'Command'}</label>
                <input className="form-input" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder={form.managed_by === 'external' ? 'next start' : 'node server.js'} required />
              </div>
              {form.managed_by === 'external' && (
                <div className="form-group">
                  <label className="form-label">Match Pattern</label>
                  <input className="form-input" value={form.match_pattern} onChange={(e) => setForm({ ...form, match_pattern: e.target.value })}
                    placeholder="next start" />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    String to match in /proc cmdline to find the PID. Leave blank to use the command.
                  </div>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Working Directory</label>
                <input className="form-input" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                  placeholder="/home/user/my-app" />
              </div>
              {form.managed_by === 'agent' && (
                <div className="form-group">
                  <label className="form-label">Environment Variables</label>
                  <textarea className="form-input" rows={4} value={form.env_vars_text}
                    onChange={(e) => setForm({ ...form, env_vars_text: e.target.value })}
                    placeholder="PORT=8280&#10;NODE_ENV=production&#10;API_KEY=xxx"
                    style={{ fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    One KEY=value per line. Lines starting with # are ignored.
                  </div>
                </div>
              )}
              {form.managed_by === 'agent' && (
                <div className="form-group" style={{ display: 'flex', gap: 16 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <input type="checkbox" checked={form.autorestart} onChange={(e) => setForm({ ...form, autorestart: e.target.checked })} />
                    Auto-restart
                  </label>
                  <div>
                    <label className="form-label" style={{ marginBottom: 4 }}>Max Restarts</label>
                    <input type="number" className="form-input" style={{ width: 80 }} value={form.max_restarts}
                      onChange={(e) => setForm({ ...form, max_restarts: parseInt(e.target.value) || 10 })} />
                  </div>
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => { setShowAddProcess(false); setEditingProcess(null); }}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editingProcess ? 'Save Changes' : 'Create Process'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fade-in" style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          background: toast.type === 'error' ? 'var(--red-dim)' : 'var(--green-dim)',
          color: '#fff',
          padding: '12px 20px',
          borderRadius: 'var(--radius)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          fontSize: 13,
          fontWeight: 600,
          zIndex: 500,
          border: `1px solid ${toast.type === 'error' ? 'var(--red)' : 'var(--green)'}`,
        }}>
          {toast.type === 'error' ? '✗ ' : '✓ '}{toast.message}
        </div>
      )}
    </div>
  );
}
