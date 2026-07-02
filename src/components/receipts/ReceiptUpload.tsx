'use client'

import { useState, useRef } from 'react'
import { Paperclip, X, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface ReceiptUploadProps {
  expenseId: string
  onUploaded?: () => void
}

const MAX_SIZE_MB = 10
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

export function ReceiptUpload({ expenseId, onUploaded }: ReceiptUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    const selected = Array.from(e.target.files ?? [])
    const filtered: File[] = []
    for (const f of selected) {
      if (!ALLOWED_TYPES.includes(f.type)) {
        setError('JPG, PNG, PDF 파일만 업로드 가능합니다.')
        continue
      }
      if (f.size > MAX_SIZE_MB * 1024 * 1024) {
        setError(`파일 크기는 ${MAX_SIZE_MB}MB 이하여야 합니다.`)
        continue
      }
      filtered.push(f)
    }
    setFiles((prev) => [...prev, ...filtered].slice(0, 5))
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleUpload() {
    if (files.length === 0) return
    setUploading(true)
    setError(null)
    const supabase = createClient()

    try {
      for (const file of files) {
        const path = `${expenseId}/${Date.now()}_${file.name}`
        const { error: storageErr } = await supabase.storage
          .from('receipts')
          .upload(path, file)
        if (storageErr) throw new Error(storageErr.message)

        const { error: dbErr } = await supabase.from('receipts').insert({
          expense_id: expenseId,
          file_path: path,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
        })
        if (dbErr) throw new Error(dbErr.message)
      }
      setFiles([])
      setDone(true)
      onUploaded?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-700">영수증 첨부 (최대 5개, 10MB)</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700"
        >
          <Paperclip className="h-3.5 w-3.5" />
          파일 선택
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.pdf"
        className="hidden"
        onChange={handleSelect}
      />

      {files.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-1.5">
              <span className="text-xs text-gray-700 truncate max-w-[200px]">{f.name}</span>
              <button type="button" onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500 ml-2">
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {done && <p className="text-xs text-green-600 mb-2">업로드 완료되었습니다.</p>}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleUpload}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          {uploading ? '업로드 중...' : '업로드'}
        </button>
      )}
    </div>
  )
}
