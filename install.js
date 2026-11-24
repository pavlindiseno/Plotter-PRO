const installButton = document.getElementById('install-app');
let installationPrompt;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installationPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener('click', async () => {
  if (!installationPrompt) return;
  const promptEvent = installationPrompt;
  installationPrompt = null;
  installButton.hidden = true;
  try {
    await promptEvent.prompt();
  } catch (error) {
    console.warn('El navegador no pudo mostrar el diálogo de instalación.', error);
  }
});

window.addEventListener('appinstalled', () => {
  installationPrompt = null;
  installButton.hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.warn('No se pudo activar la caché de Plotter Fácil.', error);
  });
}
