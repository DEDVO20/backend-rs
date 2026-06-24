import { supabase } from '../../lib/supabase.js'
import type { z }   from 'zod'
import type {
  listDocumentsQuerySchema,
  createDocumentSchema,
  updateDocumentSchema,
} from './documents.schema.js'

type ListQuery    = z.infer<typeof listDocumentsQuerySchema>
type CreateInput  = z.infer<typeof createDocumentSchema>
type UpdateInput  = z.infer<typeof updateDocumentSchema>

export class DocumentsService {
  static async list(query: ListQuery, userCompanyId: string | null, isInternal: boolean) {
    const { category, company_id, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('documents')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (!isInternal) {
      if (!userCompanyId) return { data: [], total: 0, page, limit }
      q = q.eq('company_id', userCompanyId)
    } else if (company_id) {
      q = q.eq('company_id', company_id)
    }

    if (category) q = q.eq('category', category)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async getById(id: string) {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  static async create(input: CreateInput, companyId: string, uploadedBy: string) {
    const { data, error } = await supabase
      .from('documents')
      .insert({ ...input, company_id: companyId, uploaded_by: uploadedBy })
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async update(id: string, input: UpdateInput) {
    const { data, error } = await supabase
      .from('documents')
      .update(input)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async delete(id: string) {
    const { error } = await supabase
      .from('documents')
      .delete()
      .eq('id', id)

    if (error) throw error
  }

  // Genera URL firmada temporal para descarga directa desde Supabase Storage
  static async getSignedUrl(storagePath: string, expiresIn = 3600) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(storagePath, expiresIn)

    if (error) throw error
    return data.signedUrl
  }

  // Sube un archivo a Supabase Storage y crea el registro en la tabla documents
  static async upload(
    file: File,
    meta: { title: string; category?: string; description?: string },
    companyId: string | null,
    uploadedBy: string,
  ) {
    const ext  = file.name.split('.').pop() ?? 'bin'
    const folder = companyId ?? 'uploads'
    const path = `${folder}/${Date.now()}-${crypto.randomUUID()}.${ext}`

    const buffer = await file.arrayBuffer()

    const { error: storageError } = await supabase.storage
      .from('documents')
      .upload(path, buffer, {
        contentType:  file.type || 'application/octet-stream',
        cacheControl: '3600',
        upsert:       false,
      })

    if (storageError) throw storageError

    const { data: urlData } = await supabase.storage
      .from('documents')
      .getPublicUrl(path)

    const { data, error } = await supabase
      .from('documents')
      .insert({
        ...meta,
        company_id:    companyId,
        uploaded_by:   uploadedBy,
        storage_path:  path,
        file_url:      urlData.publicUrl,
        original_name: file.name,
        mime_type:     file.type || null,
        size_bytes:    file.size,
      })
      .select()
      .single()

    if (error) {
      // Limpiar el archivo si falla la inserción en BD
      await supabase.storage.from('documents').remove([path])
      throw error
    }

    return data
  }

  // Elimina el archivo de Storage y el registro de la BD
  static async deleteWithFile(id: string) {
    const doc = await DocumentsService.getById(id)

    if (doc.storage_path) {
      await supabase.storage.from('documents').remove([doc.storage_path])
    }

    const { error } = await supabase.from('documents').delete().eq('id', id)
    if (error) throw error
  }

  // Sube un archivo KYC a Supabase Storage y devuelve la ruta
  static async uploadKycFile(
    file: File,
    onboardingId: string,
  ): Promise<{ storagePath: string; fileUrl: string }> {
    const ext  = (file.name.split('.').pop() ?? 'bin').toLowerCase()
    const path = `kyc/${onboardingId}/${Date.now()}-${crypto.randomUUID()}.${ext}`

    const MIME_BY_EXT: Record<string, string> = {
      pdf:  'application/pdf',
      jpg:  'image/jpeg',
      jpeg: 'image/jpeg',
      png:  'image/png',
      webp: 'image/webp',
      gif:  'image/gif',
      heic: 'image/heic',
    }
    const contentType = file.type && file.type !== 'application/octet-stream'
      ? file.type
      : (MIME_BY_EXT[ext] ?? 'application/pdf')

    const buffer = await file.arrayBuffer()

    const { error } = await supabase.storage
      .from('kyc-documents')
      .upload(path, buffer, {
        contentType,
        cacheControl: '3600',
        upsert:       false,
      })

    if (error) {
      const msg = error.message?.includes('mime type') || error.message?.includes('invalid_mime_type')
        ? `Tipo de archivo no permitido. Use PDF, JPG, PNG o WEBP.`
        : `Error al subir el archivo: ${error.message}`
      const e = new Error(msg) as any
      e.statusCode = 422
      throw e
    }

    const { data: urlData } = await supabase.storage
      .from('kyc-documents')
      .getPublicUrl(path)

    return { storagePath: path, fileUrl: urlData.publicUrl }
  }
}
