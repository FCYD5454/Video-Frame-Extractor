// analysis.worker.js
// Using TFJS via CDN to avoid build complexity in Web Worker context

importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs/dist/tf.min.js');
importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface');

// --- State ---
let model = null;
let modelLoadingPromise = null;

// --- Initialization ---
const loadModel = async () => {
  if (model) return;
  try {
    console.log('Worker: Loading BlazeFace model...');
    await tf.setBackend('webgl');
    await tf.ready();
    model = await blazeface.load();
    console.log('Worker: Model loaded');
    postMessage({ type: 'MODEL_LOADED' });
  } catch (err) {
    console.error('Worker: Model load failed', err);
    postMessage({ type: 'ERROR', message: `Model load failed: ${err.message}` });
  }
};

// --- Analysis Logic ---

const analyzeBrightness = (img) => {
  // Using OffscreenCanvas (Standard in modern workers)
  const canvas = new OffscreenCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  ctx.drawImage(img, 0, 0, 64, 64);
  
  const imageData = ctx.getImageData(0, 0, 64, 64);
  const data = imageData.data;
  let totalBrightness = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Luma: 0.2126*R + 0.7152*G + 0.0722*B
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    totalBrightness += luma;
  }

  return (totalBrightness / (data.length / 4)) / 255;
};

const analyzeFace = async (img) => {
  if (!model) {
    if (!modelLoadingPromise) {
        modelLoadingPromise = loadModel();
    }
    await modelLoadingPromise;
  }
  
  if (!model) return { hasFace: false, confidence: 0 };

  try {
    // Create a canvas for TFJS input
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    
    // Note: In worker, passing canvas/offscreenCanvas to tfjs methods usually works
    // Pass returnTensors: false
    const predictions = await model.estimateFaces(canvas, false);
    
    if (predictions.length > 0) {
      const bestConf = predictions[0].probability?.[0] || 0;
      return { hasFace: true, confidence: bestConf };
    }
    
    return { hasFace: false, confidence: 0 };

  } catch (err) {
    console.warn('Worker: Face detection error', err);
    return { hasFace: false, confidence: 0 };
  }
};

// --- Message Handler ---

self.onmessage = async (e) => {
  const { type, id, frameUrl, index, detectFaces } = e.data;

  if (type === 'ANALYZE_FRAME') {
    try {
      const response = await fetch(frameUrl);
      const blob = await response.blob();
      const imgBitmap = await createImageBitmap(blob);

      const brightness = analyzeBrightness(imgBitmap);
      
      let faceResult = { hasFace: false, confidence: 0 };
      if (detectFaces) {
         faceResult = await analyzeFace(imgBitmap);
      }

      const result = {
        type: 'FRAME_RESULT',
        id,
        index,
        url: frameUrl,
        brightness,
        hasFace: faceResult.hasFace,
        faceConfidence: faceResult.confidence
      };

      postMessage(result);
      imgBitmap.close();

    } catch (error) {
      console.error('Worker: Processing Failed', error);
      postMessage({ 
        type: 'FRAME_RESULT', 
        id, 
        index, 
        url: frameUrl, 
        brightness: 0, 
        hasFace: false, 
        error: error.message 
      });
    }
  }
};
