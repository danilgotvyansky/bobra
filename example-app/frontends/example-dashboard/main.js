import './style.css';

// Simple interactive counter to demonstrate JS functionality
let count = 0;

function render() {
  document.querySelector('#app').innerHTML = `
    <div class="card">
      <h1>🚀 Bobra Example Dashboard</h1>
      <p>Served via <code>createSpaHandler</code> from the Bobra framework.</p>
      <p>Edit <code>main.js</code> — vite watch build will rebuild automatically.</p>
      <div id="counter">
        <button id="dec">−</button>
        <span id="count">${count}</span>
        <button id="inc">+</button>
      </div>
      <span class="badge">SPA — Cloudflare Workers + Vite</span>
    </div>
  `;

  document.querySelector('#dec').addEventListener('click', () => { count--; render(); });
  document.querySelector('#inc').addEventListener('click', () => { count++; render(); });
}

render();
