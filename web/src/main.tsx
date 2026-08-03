import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ActivityGateProvider } from './lib/activityGate';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ActivityGateProvider>
          <App />
        </ActivityGateProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
