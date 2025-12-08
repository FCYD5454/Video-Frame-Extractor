"use client";

import { useState, FormEvent, useRef, useEffect, useCallback } from "react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

// --- Types ---

// Enhanced Frame Data
interface FrameData {
  url: string;
  timestamp?: number; // If FPS mode
  sceneIndex?: number; // If Scene mode
  meta?: {
    processed: boolean;
    brightness?: number; // 0-1
    hasFace?: boolean;
    faceConfidence?: number;
  };
}

interface JobFilters {
  showSelectedOnly: boolean;
  filterFaces: boolean;
  minBrightness: number;
  gridColumns: number;
}

interface Job {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  fileName: string;
  settings: {
    mode: "fps" | "scene";
    fps: number;
    threshold: number;
    startTime: number;
    endTime: number;
    width: number;
    height: number;
    format: "png" | "jpg";
    estimatedFrames?: number;
  };
  file: File;
  progress: number;
  processedFrames: number;
  startTimeStamp?: number;
  errorMessage?: string;
  result?: {
    frames: string[]; // raw URLs
    frameData?: FrameData[]; // Rich data
    zipUrl: string | null;
    videoUrl?: string | null; // Generated video
  };
  analysisStatus?: "idle" | "analyzing" | "done";
  analysisProgress?: number; // 0-100
  
  // UI State Persistence (Per Job)
  viewState: JobFilters;
  selectedFrames: Set<string>;
}

// Helper to format seconds into MM:SS.ms
const formatTime = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.round((totalSeconds % 1) * 100);

  const pad = (num: number) => num.toString().padStart(2, "0");
  const msStr = milliseconds.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${msStr}`;
  }
  return `${minutes}:${pad(seconds)}.${msStr}`;
};

const DEFAULT_FILTERS: JobFilters = {
  showSelectedOnly: false,
  filterFaces: false,
  minBrightness: 0,
  gridColumns: 4
};

export default function Home() {
  // Input State
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  
  // Settings State
  const [mode, setMode] = useState<"fps" | "scene">("fps");
  const [fps, setFps] = useState<number>(1);
  const [threshold, setThreshold] = useState<number>(0.3);
  const [startTime, setStartTime] = useState<number>(0);
  const [endTime, setEndTime] = useState<number>(10);
  const [width, setWidth] = useState<number>(1920);
  const [height, setHeight] = useState<number>(1080);
  const [format, setFormat] = useState<"png" | "jpg">("jpg");
  
  // Job Queue State
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null); 
  
  // UI State for Active Job View
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState<number>(20);
  
  // Lightbox State
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  
  // Video Export State
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [exportFps, setExportFps] = useState<number>(30);
  const [showExportModal, setShowExportModal] = useState(false);
  
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const workerRef = useRef<Worker | null>(null);

  // Active Job Helpers
  const activeJob = jobs.find(j => j.id === activeJobId);
  
  // Derived view frames (filtered based on Active Job state)
  const displayFrames = (activeJob?.result?.frameData || []).filter(f => {
    if (!activeJob) return false;
    const { viewState, selectedFrames } = activeJob;
    
    if (viewState.showSelectedOnly && !selectedFrames.has(f.url)) return false;
    if (viewState.filterFaces && !f.meta?.hasFace) return false;
    if (viewState.minBrightness > 0 && (f.meta?.brightness || 0) < viewState.minBrightness) return false;
    return true;
  });

  // Derived state for current input estimation
  const duration = Math.max(0, endTime - startTime);
  const estimatedInputFrames = mode === "fps" ? Math.floor(duration * fps) : undefined;

  // --- State Update Helpers ---
  
  const updateJobState = (jobId: string, updates: Partial<Job>) => {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, ...updates } : j));
  };

  const updateJobViewState = (jobId: string, updates: Partial<JobFilters>) => {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, viewState: { ...j.viewState, ...updates } } : j));
  };

  const updateJobSelection = (jobId: string, newSelection: Set<string>) => {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, selectedFrames: newSelection } : j));
  };

  // --- Worker Initialization ---
  useEffect(() => {
    workerRef.current = new Worker('/analysis.worker.js');
    
    workerRef.current.onmessage = (e) => {
      const { type, id, index, brightness, hasFace, faceConfidence } = e.data;
      
      if (type === 'FRAME_RESULT') {
        // Update Job State inside setState to avoid stale closure
        setJobs(prev => prev.map(j => {
          if (j.id === id) {
             const newFrames = j.result?.frameData ? [...j.result.frameData] : [];
             // Update the specific frame
             if (newFrames[index]) {
               newFrames[index] = {
                 ...newFrames[index],
                 meta: { processed: true, brightness, hasFace, faceConfidence }
               };
             }
             
             // Calculate progress
             const processedCount = newFrames.filter(f => f.meta?.processed).length;
             const total = newFrames.length;
             const newProgress = Math.round((processedCount / total) * 100);
             const newStatus = processedCount === total ? "done" : "analyzing";

             return { 
               ...j, 
               result: { ...j.result!, frameData: newFrames },
               analysisStatus: newStatus as any,
               analysisProgress: newProgress
             };
          }
          return j;
        }));
      } else if (type === 'MODEL_LOADED') {
        console.log("Main: AI Model Loaded");
      }
    };

    return () => {
      workerRef.current?.terminate();
    };
  }, []); 

  // --- Analysis Trigger ---
  const startAnalysis = (jobId: string) => {
    const job = jobs.find(j => j.id === jobId);
    if (!job || !job.result?.frameData || job.analysisStatus === 'analyzing') return;

    updateJobState(jobId, { analysisStatus: "analyzing", analysisProgress: 0 });

    // Send tasks to worker
    job.result.frameData.forEach((frame, idx) => {
      workerRef.current?.postMessage({
        type: 'ANALYZE_FRAME',
        id: jobId,
        frameUrl: frame.url,
        index: idx,
        detectFaces: true // Always detect faces if requested
      });
    });
  };

  // --- Video Generation ---
  const handleCreateVideo = async () => {
    if (!activeJob) return;
    setIsExportingVideo(true);
    
    try {
      // Determine which frames to use: Selected OR All Filtered OR All
      let framesToUse: string[] = [];
      
      if (activeJob.selectedFrames.size > 0) {
        // If manually selected, use those in the order they appear in full list
        // Note: displayFrames is already sorted/filtered, but selectedFrames is a Set.
        // To maintain order, we filter displayFrames (or full frames?) 
        // Usually users want to export what they "See" or "Selected".
        // If "Show Selected Only" is on, displayFrames IS the selection.
        // If not, we should filter activeJob.result.frames by selection.
        framesToUse = activeJob.result?.frames?.filter(url => activeJob.selectedFrames.has(url)) || [];
      } else {
        // If no selection, use currently visible frames (filtered)
        framesToUse = displayFrames.map(f => f.url);
      }

      if (framesToUse.length === 0) {
        alert("No frames to export!");
        return;
      }

      const response = await fetch("/api/create-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: activeJob.backendId || activeJob.id, // Use backend ID if available
          frames: framesToUse,
          fps: exportFps
        })
      });

      const data = await response.json();
      
      if (response.ok) {
        // Update job with video result
        setJobs(prev => prev.map(j => j.id === activeJob.id ? { 
          ...j, 
          result: { ...j.result!, videoUrl: data.videoUrl } 
        } : j));
        setShowExportModal(false);
      } else {
        alert(`Error: ${data.error}`);
      }

    } catch (error) {
      console.error(error);
      alert("Failed to create video");
    } finally {
      setIsExportingVideo(false);
    }
  };

  // --- Queue Processor ---
  useEffect(() => {
    const processingJob = jobs.find(j => j.status === "processing");
    if (processingJob) return; // Busy

    const nextJob = jobs.find(j => j.status === "queued");
    if (nextJob) {
      processJob(nextJob);
    }
  }, [jobs]);

  const processJob = async (job: Job) => {
    updateJobState(job.id, { status: "processing", startTimeStamp: Date.now() });
    setActiveJobId(job.id);

    try {
      const formData = new FormData();
      formData.append("video", job.file);
      formData.append("mode", job.settings.mode);
      formData.append("fps", job.settings.fps.toString());
      formData.append("threshold", job.settings.threshold.toString());
      formData.append("startTime", job.settings.startTime.toString());
      formData.append("endTime", job.settings.endTime.toString());
      formData.append("width", job.settings.width.toString());
      formData.append("height", job.settings.height.toString());
      formData.append("format", job.settings.format);

      const response = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });

      if (!response.ok || !response.body) {
        throw new Error("Failed to start extraction");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "progress") {
               setJobs(prev => prev.map(j => {
                 if (j.id === job.id) {
                   return { 
                     ...j, 
                     progress: Math.round(msg.percent),
                     processedFrames: msg.frames || j.processedFrames
                   };
                 }
                 return j;
               }));
            } else if (msg.type === "complete") {
              // Init FrameData structure
              const rawFrames = msg.data.frames as string[];
              const frameData: FrameData[] = rawFrames.map(url => ({ url }));

              setJobs(prev => prev.map(j => {
                 if (j.id === job.id) {
                   return { 
                     ...j, 
                     status: "completed", 
                     progress: 100,
                     backendId: msg.data.directory, // Save backend ID
                     result: {
                       frames: rawFrames,
                       frameData: frameData,
                       zipUrl: msg.data.zipUrl
                     },
                     analysisStatus: 'idle',
                     analysisProgress: 0
                   };
                 }
                 return j;
               }));
            } else if (msg.type === "error") {
               throw new Error(msg.error);
            }
          } catch (e) {
            console.warn("Failed to parse stream line", line);
          }
        }
      }
    } catch (error: any) {
      console.error(error);
      updateJobState(job.id, { status: "error", errorMessage: error.message });
    }
  };

  // --- Handlers ---

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      const url = URL.createObjectURL(selectedFile);
      setVideoUrl(url);
    }
  };

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const handleSetStartTime = () => {
    if (videoRef.current) {
      setStartTime(Number(videoRef.current.currentTime.toFixed(1)));
    }
  };

  const handleSetEndTime = () => {
    if (videoRef.current) {
      setEndTime(Number(videoRef.current.currentTime.toFixed(1)));
    }
  };

  const handleAddToQueue = (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      alert("Please select a video file.");
      return;
    }

    const newJob: Job = {
      id: Date.now().toString(),
      status: "queued",
      fileName: file.name,
      file: file,
      settings: {
        mode,
        fps,
        threshold,
        startTime,
        endTime,
        width,
        height,
        format,
        estimatedFrames: estimatedInputFrames
      },
      progress: 0,
      processedFrames: 0,
      viewState: { ...DEFAULT_FILTERS },
      selectedFrames: new Set()
    };

    setJobs(prev => [...prev, newJob]);
    if (!activeJobId) setActiveJobId(newJob.id);
  };

  // --- View Logic ---
  
  useEffect(() => {
    // Reset UI transient state when switching jobs
    if (activeJobId) {
       setLastSelectedIndex(null);
       setVisibleCount(20);
    }
  }, [activeJobId]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && displayFrames.length > visibleCount) {
          setVisibleCount((prev) => Math.min(prev + 20, displayFrames.length));
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [displayFrames.length, visibleCount]);

  // Selection Logic
  const handleSelection = (src: string, index: number, e: React.MouseEvent) => {
    if (!activeJob) return;
    if (e.shiftKey) {
      window.getSelection()?.removeAllRanges();
    }
    const newSet = new Set(activeJob.selectedFrames);
    
    // Note: Index here is VISUAL index in displayFrames
    const targetFrame = displayFrames[index];
    if (!targetFrame) return;

    if (e.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      for (let i = start; i <= end; i++) {
        if (displayFrames[i]) newSet.add(displayFrames[i].url);
      }
    } else {
      if (newSet.has(targetFrame.url)) {
        newSet.delete(targetFrame.url);
      } else {
        newSet.add(targetFrame.url);
      }
      setLastSelectedIndex(index);
    }
    updateJobSelection(activeJob.id, newSet);
  };

  const selectAll = () => {
    if (!activeJob) return;
    if (activeJob.selectedFrames.size === displayFrames.length && displayFrames.length > 0) {
      updateJobSelection(activeJob.id, new Set());
      setLastSelectedIndex(null);
    } else {
      const newSet = new Set(activeJob.selectedFrames);
      displayFrames.forEach(f => newSet.add(f.url));
      updateJobSelection(activeJob.id, newSet);
    }
  };

  const downloadSelected = async () => {
    if (!activeJob || activeJob.selectedFrames.size === 0) return;
    const zip = new JSZip();
    const folder = zip.folder("selected_frames");
    let count = 0;
    for (const src of Array.from(activeJob.selectedFrames)) {
      const filename = src.split('/').pop() || `frame_${count}.${format}`;
      const blob = await fetch(src).then(r => r.blob());
      folder?.file(filename, blob);
      count++;
    }
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, "selected_frames.zip");
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const getJobEta = (job: Job) => {
    if (job.status !== "processing" || !job.startTimeStamp || job.progress === 0) return null;
    const elapsed = (Date.now() - job.startTimeStamp) / 1000; 
    const rate = job.progress / elapsed; 
    const remainingPercent = 100 - job.progress;
    const remainingSeconds = remainingPercent / rate;
    if (remainingSeconds < 0 || !isFinite(remainingSeconds)) return null;
    return `${Math.ceil(remainingSeconds)}s`;
  };

  // Lightbox Logic
  const openLightbox = (index: number) => {
    setLightboxIndex(index);
    setZoomLevel(1);
  };

  const closeLightbox = () => {
    setLightboxIndex(null);
    setZoomLevel(1);
  };

  const nextImage = useCallback(() => {
    if (lightboxIndex !== null && lightboxIndex < displayFrames.length - 1) {
      setLightboxIndex(lightboxIndex + 1);
      setZoomLevel(1);
    }
  }, [lightboxIndex, displayFrames.length]);

  const prevImage = useCallback(() => {
    if (lightboxIndex !== null && lightboxIndex > 0) {
      setLightboxIndex(lightboxIndex - 1);
      setZoomLevel(1);
    }
  }, [lightboxIndex]);

  // Keyboard Navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (lightboxIndex === null) return;
      if (e.key === "ArrowRight") nextImage();
      if (e.key === "ArrowLeft") prevImage();
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxIndex, nextImage, prevImage]);

  // Get timestamp for frame
  const getFrameTimestamp = (idx: number) => {
     if (!activeJob || !displayFrames[idx]) return "";
     // Find original index in FULL frames list to calculate time
     // Note: FrameData object identity or URL can match
     const originalIdx = activeJob.result?.frameData?.findIndex(f => f.url === displayFrames[idx].url) ?? -1;
     
     if (activeJob.settings.mode === "fps") {
        const timestamp = activeJob.settings.startTime + (originalIdx / activeJob.settings.fps);
        return formatTime(timestamp);
     } else {
        return `Scene #${originalIdx + 1}`;
     }
  };

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-[90rem] mx-auto bg-white rounded-lg shadow-md overflow-hidden">
        <div className="bg-blue-600 px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-white">Video Frame Extractor</h1>
            <p className="text-blue-100 text-sm">Task Queue & Gallery</p>
          </div>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Input Form (3 cols) */}
          <div className="lg:col-span-3 space-y-6 border-r border-gray-100 pr-6">
             {/* ... Form Content ... */}
             <h2 className="text-lg font-semibold text-gray-800">New Task</h2>
             {/* Video Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Video File</label>
              <input type="file" accept="video/*" onChange={handleFileChange} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
            </div>
            {videoUrl && (
              <div className="bg-black rounded-lg overflow-hidden aspect-video relative group">
                <video ref={videoRef} src={videoUrl} controls className="w-full h-full" />
              </div>
            )}
            <form onSubmit={handleAddToQueue} className="space-y-4">
              {/* Settings (Condensed) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Mode</label>
                <div className="flex bg-gray-100 p-1 rounded-md">
                  <button type="button" onClick={() => setMode("fps")} className={`flex-1 py-1.5 text-xs font-medium rounded-md ${mode === "fps" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"}`}>Periodic</button>
                  <button type="button" onClick={() => setMode("scene")} className={`flex-1 py-1.5 text-xs font-medium rounded-md ${mode === "scene" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"}`}>Scene</button>
                </div>
              </div>
              {mode === "fps" ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">FPS</label>
                  <input type="number" value={fps} onChange={(e) => setFps(Number(e.target.value))} className="w-full px-3 py-2 border border-gray-300 rounded-md text-black" min="0.01" step="0.01" />
                </div>
              ) : (
                <div>
                   <div className="flex justify-between items-center mb-1"><label className="block text-sm font-medium text-gray-700">Sensitivity</label></div>
                   <input type="range" min="0.01" max="0.9" step="0.01" value={1 - threshold} onChange={(e) => setThreshold(1 - Number(e.target.value))} className="w-full" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Start (s)</label>
                  <div className="flex gap-1">
                    <input type="number" value={startTime} onChange={(e) => setStartTime(Number(e.target.value))} className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm text-black" min="0" step="0.1" />
                    <button type="button" onClick={handleSetStartTime} disabled={!videoUrl} className="px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 text-xs">Use</button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">End (s)</label>
                  <div className="flex gap-1">
                    <input type="number" value={endTime} onChange={(e) => setEndTime(Number(e.target.value))} className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm text-black" min="0" step="0.1" />
                    <button type="button" onClick={handleSetEndTime} disabled={!videoUrl} className="px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 text-xs">Use</button>
                  </div>
                </div>
              </div>
              <div className="bg-blue-50 p-2 rounded-md border border-blue-100 text-blue-800 text-xs">
                <div>Duration: <strong>{duration.toFixed(1)}s</strong></div>
                {mode === "fps" && <div>Est: <strong>~{estimatedInputFrames}</strong> frames</div>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="block text-xs font-medium text-gray-700 mb-1">W (px)</label><input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm text-black" /></div>
                <div><label className="block text-xs font-medium text-gray-700 mb-1">H (px)</label><input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm text-black" /></div>
              </div>
              <button type="submit" className="w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700">Add to Queue</button>
            </form>
          </div>

          {/* Right Column: Job List & Results (9 cols) */}
          <div className="lg:col-span-9 flex flex-col gap-6 h-[850px]">
             {/* Job Queue List */}
             <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden flex flex-col h-1/3 min-h-[200px]">
                <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex justify-between items-center">
                   <h3 className="font-semibold text-gray-700">Job Queue ({jobs.length})</h3>
                </div>
                <div className="overflow-y-auto p-0">
                  <table className="min-w-full divide-y divide-gray-200">
                       <thead className="bg-gray-50">
                         <tr>
                           <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">File</th>
                           <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                           <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-1/3">Progress</th>
                           <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
                         </tr>
                       </thead>
                       <tbody className="bg-white divide-y divide-gray-200">
                         {jobs.slice().reverse().map(job => (
                             <tr key={job.id} className={`${activeJobId === job.id ? 'bg-blue-50' : ''} hover:bg-gray-50`}>
                               <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900 truncate max-w-[200px]" title={job.fileName}>{job.fileName}</td>
                               <td className="px-4 py-3 whitespace-nowrap text-sm"><span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${job.status === 'completed' ? 'bg-green-100 text-green-800' : job.status === 'processing' ? 'bg-yellow-100 text-yellow-800' : job.status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'}`}>{job.status}</span></td>
                               <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                                 {job.status === 'processing' ? (
                                   <div className="w-full"><div className="flex justify-between text-xs mb-1"><span>{job.progress}%</span><span>{job.processedFrames} f</span>{getJobEta(job) && <span className="text-blue-600">ETA: {getJobEta(job)}</span>}</div><div className="w-full bg-gray-200 rounded-full h-1.5"><div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${job.progress}%` }}></div></div></div>
                                 ) : job.status === 'completed' ? <span className="text-xs text-green-600">{job.result?.frames.length} frames</span> : <span className="text-xs text-gray-400">Waiting</span>}
                               </td>
                               <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500"><button onClick={() => setActiveJobId(job.id)} className="text-blue-600 hover:text-blue-900">View</button></td>
                             </tr>
                         ))}
                       </tbody>
                    </table>
                </div>
             </div>

             {/* Active Job Gallery & Filters */}
             <div className="bg-gray-50 rounded-lg p-4 flex-1 overflow-hidden flex flex-col border border-gray-200">
                {!activeJob ? (
                   <div className="flex-1 flex items-center justify-center text-gray-400">Select a job to view results</div>
                ) : (
                  <>
                    {/* Toolbar */}
                    <div className="flex flex-col gap-2 mb-4 pb-2 border-b border-gray-200 flex-shrink-0">
                      {/* Row 1: Title & Analysis */}
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-medium text-gray-900 truncate max-w-[200px]">{activeJob.fileName}</h3>
                          <span className="text-sm text-gray-500">
                            {displayFrames.length} frames 
                            {activeJob.viewState.showSelectedOnly && ` (Selected)`}
                            {activeJob.viewState.filterFaces && ` (Faces)`}
                          </span>
                        </div>
                        
                        <div className="flex items-center gap-2">
                           {/* Video Export Button */}
                           {activeJob.status === 'completed' && (
                             <div className="flex gap-2">
                               {activeJob.result?.videoUrl && (
                                 <a href={activeJob.result.videoUrl} download className="text-xs px-3 py-1.5 bg-purple-50 text-purple-700 border border-purple-200 rounded hover:bg-purple-100 flex items-center gap-1">
                                   <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                   Download Video
                                 </a>
                               )}
                               
                               <button onClick={() => setShowExportModal(true)} className="text-xs px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-50 flex items-center gap-1">
                                 <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                 {activeJob.result?.videoUrl ? "Re-create Video" : "Create Video"}
                               </button>
                             </div>
                           )}

                           {/* Analysis Button */}
                           {activeJob.status === 'completed' && (
                             activeJob.analysisStatus === 'analyzing' ? (
                                <span className="text-xs text-blue-600 flex items-center gap-1">
                                  <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                  Analyzing ({activeJob.analysisProgress}%)
                                </span>
                             ) : activeJob.analysisStatus === 'done' ? (
                                <span className="text-xs text-green-600 font-medium">Analysis Complete</span>
                             ) : (
                                <button onClick={() => startAnalysis(activeJob.id)} className="text-xs px-3 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded hover:bg-indigo-100 flex items-center gap-1">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" /></svg>
                                  Analyze Content
                                </button>
                             )
                           )}
                        </div>
                      </div>

                      {/* Row 2: Filters & Actions */}
                      {activeJob.result?.frames?.length! > 0 && (
                        <div className="flex flex-wrap gap-3 items-center text-xs text-gray-600 bg-white p-2 rounded border border-gray-200">
                           {/* Filter: Selected */}
                           <label className="flex items-center gap-1 cursor-pointer select-none">
                             <input 
                               type="checkbox" 
                               checked={activeJob.viewState.showSelectedOnly} 
                               onChange={() => updateJobViewState(activeJob.id, { showSelectedOnly: !activeJob.viewState.showSelectedOnly })} 
                               className="rounded text-blue-600" 
                             />
                             <span>Selected Only</span>
                           </label>

                           <div className="h-4 w-px bg-gray-300"></div>

                           {/* Filter: Faces */}
                           <label className={`flex items-center gap-1 cursor-pointer select-none ${!activeJob.analysisStatus ? 'opacity-50' : ''}`}>
                             <input 
                               type="checkbox" 
                               checked={activeJob.viewState.filterFaces} 
                               onChange={() => updateJobViewState(activeJob.id, { filterFaces: !activeJob.viewState.filterFaces })} 
                               disabled={activeJob.analysisStatus !== 'done'} 
                               className="rounded text-blue-600" 
                             />
                             <span>Faces Only</span>
                           </label>

                           <div className="h-4 w-px bg-gray-300"></div>

                           {/* Filter: Brightness */}
                           <div className={`flex items-center gap-2 ${!activeJob.analysisStatus ? 'opacity-50' : ''}`}>
                             <span>Min Brightness:</span>
                             <input 
                               type="range" 
                               min="0" 
                               max="0.9" 
                               step="0.1" 
                               value={activeJob.viewState.minBrightness} 
                               onChange={(e) => updateJobViewState(activeJob.id, { minBrightness: Number(e.target.value) })} 
                               disabled={activeJob.analysisStatus !== 'done'} 
                               className="w-16" 
                             />
                           </div>

                           <div className="flex-1"></div>

                           {/* Grid Size */}
                           <span className="hidden sm:inline">Size:</span>
                           <input 
                             type="range" 
                             min="1" 
                             max="6" 
                             value={activeJob.viewState.gridColumns} 
                             onChange={(e) => updateJobViewState(activeJob.id, { gridColumns: Number(e.target.value) })} 
                             className="w-16 hidden sm:block" 
                           />

                           {/* Actions */}
                           <button onClick={selectAll} className="px-2 py-1 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200">
                             {activeJob.selectedFrames.size === displayFrames.length && displayFrames.length > 0 ? "Unselect" : "Select All"}
                           </button>

                          {activeJob.selectedFrames.size > 0 && (
                             <button onClick={downloadSelected} className="px-2 py-1 bg-blue-600 text-white border border-transparent rounded hover:bg-blue-700">
                              Download ({activeJob.selectedFrames.size})
                            </button>
                          )}
                          {activeJob.result?.zipUrl && <a href={activeJob.result.zipUrl} download="frames.zip" className="text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700">Download All</a>}
                        </div>
                      )}
                    </div>
                    
                    {displayFrames.length === 0 ? (
                      <div className="flex-1 flex items-center justify-center text-gray-400">
                        {activeJob.viewState.showSelectedOnly ? 'No frames selected' : (activeJob.status === 'processing' ? 'Processing frames...' : 'No frames match filters')}
                      </div>
                    ) : (
                      <div className="flex-1 overflow-y-auto pr-2">
                        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${activeJob.viewState.gridColumns}, minmax(0, 1fr))` }}>
                          {displayFrames.slice(0, visibleCount).map((frame, idx) => {
                             const isSelected = activeJob.selectedFrames.has(frame.url);
                             const fileName = frame.url.split('/').pop() || `frame_${idx}`;
                             const absoluteUrl = typeof window !== 'undefined' ? `${window.location.origin}${frame.url}` : frame.url;
                             
                             return (
                              <div key={idx} className={`flex flex-col bg-white border rounded shadow-sm overflow-hidden hover:shadow-md transition-shadow ${isSelected ? 'ring-2 ring-blue-500 border-transparent' : 'border-gray-200'}`}>
                                <div className="p-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                                  <label className="flex items-center space-x-2 cursor-pointer select-none w-full">
                                    <input type="checkbox" checked={isSelected} onChange={(e) => handleSelection(frame.url, idx, e)} readOnly className="rounded text-blue-600 h-4 w-4 border-gray-300" />
                                    <span className="text-xs text-gray-600 truncate flex-1" title={fileName}>{fileName}</span>
                                  </label>
                                </div>
                                <div className="relative aspect-video bg-gray-200 cursor-pointer group" onClick={(e) => handleSelection(frame.url, idx, e)}>
                                  <img src={frame.url} loading="lazy" alt={`Frame ${idx}`} className="object-cover w-full h-full" />
                                  
                                  {/* Badges */}
                                  <div className="absolute top-1 right-1 flex flex-col gap-1 items-end">
                                     {frame.meta?.hasFace && (
                                       <span className="bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded shadow-sm" title="Face Detected">Face</span>
                                     )}
                                  </div>

                                  <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded backdrop-blur-sm pointer-events-none">{getFrameTimestamp(idx)}</div>
                                  
                                  {/* Open Hover Button */}
                                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openLightbox(idx); }}
                                      className="px-4 py-2 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-full text-gray-900 font-medium text-xs shadow-lg hover:bg-white transform scale-95 group-hover:scale-100 transition-all"
                                    >
                                      Open
                                    </button>
                                  </div>
                                </div>
                                <div className="p-2 bg-gray-50 border-t border-gray-100 flex flex-col gap-2">
                                   <button onClick={(e) => { e.stopPropagation(); openLightbox(idx); }} className="w-full py-1.5 px-2 bg-white border border-gray-300 rounded text-xs font-medium text-gray-700 hover:bg-gray-100">Open</button>
                                  {isSelected && (
                                    <div className="flex gap-1">
                                      <button onClick={() => copyToClipboard(absoluteUrl)} className="flex-1 text-[10px] bg-white border border-gray-300 text-gray-700 py-1 px-1 rounded hover:bg-gray-100">Copy URL</button>
                                      <button onClick={() => copyToClipboard(fileName)} className="flex-1 text-[10px] bg-white border border-gray-300 text-gray-700 py-1 px-1 rounded hover:bg-gray-100">Copy Name</button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {visibleCount < displayFrames.length && <div ref={loadMoreRef} className="h-10 flex items-center justify-center mt-4"><span className="text-gray-400 text-sm">Loading more frames...</span></div>}
                      </div>
                    )}
                  </>
                )}
             </div>
          </div>
        </div>
      </div>

      {/* Export Video Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Export Video</h3>
            
            <div className="mb-4 text-sm text-gray-600">
              Creating video from {activeJob?.selectedFrames.size || displayFrames.length} frames.
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">Framerate (FPS)</label>
              <input 
                type="number" 
                value={exportFps} 
                onChange={(e) => setExportFps(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-black"
                min="1"
                max="60"
              />
              <p className="text-xs text-gray-500 mt-1">Controls playback speed (Higher = Faster)</p>
            </div>

            <div className="flex justify-end gap-2">
              <button 
                onClick={() => setShowExportModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreateVideo}
                disabled={isExportingVideo}
                className={`px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 flex items-center gap-2 ${isExportingVideo ? 'opacity-70 cursor-not-allowed' : ''}`}
              >
                {isExportingVideo && <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>}
                {isExportingVideo ? "Creating..." : "Generate Video"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enhanced Lightbox */}
      {lightboxIndex !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-90 backdrop-blur-sm select-none" onClick={closeLightbox}>
          {/* Main Image - Rendered first (behind controls) or z-index managed */}
          <div className="relative w-full h-full flex items-center justify-center p-12" onClick={(e) => e.stopPropagation()}>
             <img 
               src={displayFrames[lightboxIndex]?.url} 
               alt={`Frame ${lightboxIndex}`}
               className="object-contain transition-transform duration-200 ease-out"
               style={{ 
                 transform: `scale(${zoomLevel})`,
                 maxWidth: '100%', 
                 maxHeight: '100%' 
               }}
             />
          </div>

          {/* Toolbar - Added z-10 */}
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-black/50 px-4 py-2 rounded-full text-white flex items-center gap-4 backdrop-blur-md z-10" onClick={(e) => e.stopPropagation()}>
             <span className="text-sm font-medium">{lightboxIndex + 1} / {displayFrames.length}</span>
             <div className="h-4 w-px bg-white/30"></div>
             <button onClick={() => setZoomLevel(z => Math.max(0.5, z - 0.25))} className="hover:text-blue-400 text-lg font-bold px-2">-</button>
             <span className="text-xs w-12 text-center">{Math.round(zoomLevel * 100)}%</span>
             <button onClick={() => setZoomLevel(z => Math.min(3, z + 0.25))} className="hover:text-blue-400 text-lg font-bold px-2">+</button>
          </div>

          {/* Close Button - Added z-10 and stopPropagation */}
          <button 
            onClick={(e) => { e.stopPropagation(); closeLightbox(); }} 
            className="absolute top-4 right-4 text-white/70 hover:text-white p-2 z-10"
          >
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Nav Buttons - Added z-10 */}
          <button onClick={(e) => { e.stopPropagation(); prevImage(); }} className={`absolute left-4 top-1/2 transform -translate-y-1/2 text-white/70 hover:text-white p-4 z-10 ${lightboxIndex === 0 ? 'opacity-20 cursor-default' : ''}`} disabled={lightboxIndex === 0}>
             <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); nextImage(); }} className={`absolute right-4 top-1/2 transform -translate-y-1/2 text-white/70 hover:text-white p-4 z-10 ${lightboxIndex === displayFrames.length - 1 ? 'opacity-20 cursor-default' : ''}`} disabled={lightboxIndex === displayFrames.length - 1}>
             <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          
          {/* Bottom Info - Added z-10 */}
          <div className="absolute bottom-4 text-white/60 text-sm font-mono z-10">
             {getFrameTimestamp(lightboxIndex)}
          </div>
        </div>
      )}
    </main>
  );
}
