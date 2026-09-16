'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import toast from 'react-hot-toast';
import { Upload, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cleanSignatureImage } from '@/lib/signature-image';

const BUCKET = 'mejasan-media';

export default function ImageUploadField({
  value, onChange, folder = 'pages', signature = false,
}: {
  value: string;
  onChange: (url: string) => void;
  folder?: string;
  /**
   * Lift the ink off the paper before storing.
   *
   * A company signature is a photograph of a signature on a sheet; a client
   * signature is drawn on a transparent canvas. Side by side in the same
   * contract the photograph reads as pasted-in. Cleaning it here means every
   * document generated afterwards is already right, with nothing to redo.
   */
  signature?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const sb = createClient();

    // Falls back to the original if the file could not be read as an image or
    // had no ink in it — better a photograph than nothing at all.
    let body: File | Blob = file;
    let name = file.name;
    if (signature) {
      const cleaned = await cleanSignatureImage(file);
      if (cleaned) {
        body = cleaned;
        name = `${file.name.replace(/\.[^.]+$/, '')}.png`;
      } else {
        toast('Kept the original — no signature could be separated from the background.');
      }
    }

    const path = `${folder}/${Date.now()}-${name}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, body, { upsert: false });
    setUploading(false);
    if (error) { console.error('Image upload failed:', error); toast.error(`Upload failed: ${error.message}`); return; }
    const { data: { publicUrl } } = sb.storage.from(BUCKET).getPublicUrl(path);
    onChange(publicUrl);
    toast.success('Image uploaded');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="space-y-2">
      {value && (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="preview"
            className={signature ? 'w-full h-32 object-contain bg-white p-2' : 'w-full h-32 object-cover opacity-70'}
          />
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-black/80 text-white p-1 transition-colors"
            aria-label="Remove image"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… or upload a file"
          className="flex-1 bg-[#0B0B0B] border border-white/[0.08] text-white/80 font-display text-[12px] px-3 py-2 focus:outline-none focus:border-[#E10600]/40 placeholder:text-white/20"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 text-[10px] font-display tracking-widest uppercase text-white/50 hover:text-white border border-white/[0.08] px-3 py-2 transition-colors disabled:opacity-50 shrink-0"
        >
          <Upload size={11} /> {uploading ? 'Uploading…' : 'Upload'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      </div>
    </div>
  );
}
