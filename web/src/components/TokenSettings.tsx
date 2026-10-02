import { useState, type FormEvent } from "react";
import { getToken, setToken } from "../api";
import "./TokenSettings.css";

export function TokenSettings() {
  const [token, setTokenValue] = useState(() => getToken());
  const [saved, setSaved] = useState(false);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setToken(token.trim());
    setTokenValue(token.trim());
    setSaved(true);
  }

  return (
    <details className="token-settings">
      <summary>API token</summary>
      <form onSubmit={save}>
        <label htmlFor="blueprint-api-token">Write API token</label>
        <div className="token-settings__controls">
          <input id="blueprint-api-token" type="password" autoComplete="off" value={token} onChange={(event) => { setTokenValue(event.target.value); setSaved(false); }} placeholder="Enter token to enable write actions" />
          <button type="submit">Save</button>
        </div>
        <p className="muted" role="status">{saved ? "Token saved in this browser." : "Required for creating, planning, approving, building, or landing tasks."}</p>
      </form>
    </details>
  );
}
