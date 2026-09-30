import { fail, ok, requirePermission } from '@/lib/api';
import { inspectWorkbook, MAX_UPLOAD_BYTES, storeUpload, uploadPath, validateUpload } from '@/lib/import/centre';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Upload one .xlsx workbook (Administrator, Manager) and look at it. Nothing is imported. */
export async function POST(req: Request) {
  try {
    await requirePermission(req, 'import.centre');
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_UPLOAD_BYTES + 1024 * 1024) throw new Error(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Choose a file to upload.');
    const buf = Buffer.from(await file.arrayBuffer());
    validateUpload(file.name, file.type, file.size, buf);
    const { uploadId, fileName } = storeUpload(file.name, buf);
    const inspection = inspectWorkbook(uploadPath(uploadId).file, fileName);
    return ok({ uploadId, inspection });
  } catch (e) {
    return fail(e);
  }
}
