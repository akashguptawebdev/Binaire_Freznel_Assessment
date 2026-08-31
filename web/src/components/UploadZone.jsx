import React, { useRef, useState } from 'react';
import { makeRandomCsv } from '../lib/csvSample.js';

/**
 * Drag-and-drop + file picker + "generate random CSV". Emits one or more
 * File objects to the parent, which queues each as its own task.
 */
export default function UploadZone({ onFiles, disabled }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length) onFiles(files);
  };

  return (
    <div
      className={`upload-zone ${dragging ? 'is-drag' : ''} ${disabled ? 'is-disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        multiple
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="uz-icon" aria-hidden>
        ⬆
      </div>
      <div className="uz-copy">
        <strong>Drop CSV file(s)</strong>
        <span>or click to browse — multiple files welcome</span>
      </div>
      <button
        type="button"
        className="uz-gen"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          const { file } = makeRandomCsv();
          onFiles([file]);
        }}
      >
        generate random CSV
      </button>
    </div>
  );
}
