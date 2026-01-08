import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import PopoutChatContent from './components/PopoutChat';
import { SocketProvider } from './contexts/SocketContext';

// Check if we should render popout chat instead of main app
const urlParams = new URLSearchParams(window.location.search);
const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

if (urlParams.get('popout') === 'true') {
  // Set up the popout window styles
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.background = '#1a1a1a';
  document.body.style.width = '100vw';
  document.body.style.height = '100vh';
  document.body.style.overflow = 'hidden';
  
  // Render the popout chat
  root.render(
    <SocketProvider>
      <PopoutChatContent />
    </SocketProvider>
  );
} else {
  // Normal app initialization
  root.render(
    // <React.StrictMode>
      <App />
    // </React.StrictMode>
  );
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
