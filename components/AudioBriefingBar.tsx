import React, { useState, useRef, useEffect } from 'react';
import { Volume2, Play, Pause, Loader2, Download, FileText, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import type { AudioBriefing } from '../types';

interface AudioBriefingBarProps {
  briefing: AudioBriefing | null;
  isGenerating: boolean;
  onGenerate: (voice: 'Kore' | 'Charon') => void;
}

export const AudioBriefingBar: React.FC<AudioBriefingBarProps> = ({
  briefing,
  isGenerating,
  onGenerate,
}) => {
  const [voice, setVoice] = useState<'Kore' | 'Charon'>(briefing?.voice || 'Kore');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (briefing?.voice) setVoice(briefing.voice);
  }, [briefing?.audioDataUrl]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.playbackRate = playbackRate;
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const cycleRate = () => {
    const next = playbackRate === 1 ? 1.25 : playbackRate === 1.25 ? 1.5 : 1;
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  const formatTime = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleDownloadWav = () => {
    if (!briefing?.audioDataUrl) return;
    const link = document.createElement('a');
    link.href = briefing.audioDataUrl;
    link.download = `vision-pro-executive-briefing-${Date.now()}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="no-print bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-800 shrink-0">
            <Volume2 size={16} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 leading-tight">
              Executive Audio Briefing
            </h3>
            <p className="text-xs text-slate-500">
              Spoken 45-second audit summary synthesized with Gemini TTS
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md">
            <button
              type="button"
              onClick={() => setVoice('Kore')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                voice === 'Kore'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Kore
            </button>
            <button
              type="button"
              onClick={() => setVoice('Charon')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                voice === 'Charon'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Charon
            </button>
          </div>

          <button
            type="button"
            onClick={() => onGenerate(voice)}
            disabled={isGenerating}
            className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isGenerating ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Synthesizing...
              </>
            ) : briefing ? (
              <>
                <RefreshCw size={13} />
                Regenerate
              </>
            ) : (
              <>
                <Volume2 size={13} />
                Generate Briefing
              </>
            )}
          </button>
        </div>
      </div>

      {briefing && (
        <div className="mt-4 pt-3.5 border-t border-slate-100 space-y-3">
          {briefing.audioDataUrl ? (
            <>
              <audio
                ref={audioRef}
                src={briefing.audioDataUrl}
                onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
                onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
                onEnded={() => setIsPlaying(false)}
              />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                  aria-label={isPlaying ? 'Pause audio briefing' : 'Play audio briefing'}
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                </button>

                <div className="flex-1 min-w-[160px] flex items-center gap-2.5">
                  <span className="text-xs font-mono tabular-nums text-slate-600 w-9 text-right">
                    {formatTime(currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 1}
                    step={0.1}
                    value={currentTime}
                    onChange={handleSeek}
                    className="flex-1 accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
                    aria-label="Audio playback position"
                  />
                  <span className="text-xs font-mono tabular-nums text-slate-500 w-9">
                    {formatTime(duration)}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={cycleRate}
                  className="px-2 py-1 text-xs font-mono tabular-nums font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap cursor-pointer"
                >
                  {playbackRate}x
                </button>

                <button
                  type="button"
                  onClick={() => setShowTranscript((v) => !v)}
                  className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded flex items-center gap-1 whitespace-nowrap cursor-pointer"
                >
                  <FileText size={12} />
                  Transcript
                  {showTranscript ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadWav}
                  className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded flex items-center gap-1 whitespace-nowrap cursor-pointer"
                >
                  <Download size={12} />
                  WAV
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500">
              Saved briefing transcript from a previous session (audio WAV is not persisted in browser storage). Click Regenerate to synthesize audio again.
            </p>
          )}

          {(showTranscript || !briefing.audioDataUrl) && (
            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-3">
              {briefing.script}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
