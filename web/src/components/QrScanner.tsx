import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import type { T } from '../i18n';

// Reads a QR code with the camera, entirely in the browser (jsQR). Used on the connect screen so
// the installed app can take the agent's QR code directly, without going through Safari.
export function QrScanner({ t, onResult, onClose }: { t: T; onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && ctx && video.readyState >= 2 && video.videoWidth > 0) {
        // Downscale for speed: decoding a ~480px frame is plenty for a QR filling the view.
        const scale = Math.min(1, 480 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          stopped = true;
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        video.setAttribute('playsinline', 'true');
        video.play().catch(() => {});
        raf = requestAnimationFrame(tick);
      })
      .catch((err: Error) => setError(err?.name === 'NotAllowedError' ? t('cameraDenied') : err?.message || t('cameraDenied')));

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scanner">
      <video ref={videoRef} className="scanner-video" muted />
      <div className="scanner-frame" aria-hidden="true" />
      <div className="scanner-bar">
        <span className="small">{error || t('scanning')}</span>
        <button className="btn compact" type="button" onClick={onClose}>
          {t('cancelQueue')}
        </button>
      </div>
    </div>
  );
}
