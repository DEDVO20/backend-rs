import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import type {
  CreateBlogPostInput,
  UpdateBlogPostInput,
  QueryBlogPostInput,
  CreateBlogCategoryInput,
  UpdateBlogCategoryInput,
} from './blog.schema.js'

export interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string
  content: string
  cover_image: string
  category: string
  tags: string[]
  author_name: string
  author_role: string
  reading_time_minutes: number
  published: boolean
  featured: boolean
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface BlogCategory {
  id: string
  name: string
  slug: string
  description?: string
  color: string
  post_count?: number
  created_at: string
  updated_at: string
}

// Categorías iniciales de semilla
const SEED_CATEGORIES: BlogCategory[] = [
  {
    id: 'c1a11111-1111-4111-8111-111111111111',
    name: 'Finanzas Corporativas',
    slug: 'finanzas-corporativas',
    description: 'Análisis de inversiones, VAN, costo de capital y estructura financiera.',
    color: 'brand',
    created_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-09-01T00:00:00Z').toISOString(),
  },
  {
    id: 'c2b22222-2222-4222-8222-222222222222',
    name: 'Tesorería & Cartera',
    slug: 'tesoreria-y-cartera',
    description: 'Control de liquidez, flujo de caja, cobranza y reducción de cartera vencida.',
    color: 'gold',
    created_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-09-01T00:00:00Z').toISOString(),
  },
  {
    id: 'c3c33333-3333-4333-8333-333333333333',
    name: 'Impuestos & Legal',
    slug: 'impuestos-y-legal',
    description: 'Obligaciones tributarias, retenciones, IVA y planeación fiscal empresarial.',
    color: 'emerald',
    created_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-09-01T00:00:00Z').toISOString(),
  },
  {
    id: 'c4d44444-4444-4444-8444-444444444444',
    name: 'Estrategia Empresarial',
    slug: 'estrategia-empresarial',
    description: 'Modelos de crecimiento, presupuestos y control de gestión estratégica.',
    color: 'blue',
    created_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-09-01T00:00:00Z').toISOString(),
  },
  {
    id: 'c5e55555-5555-4555-8555-555555555555',
    name: 'Tecnología & IA',
    slug: 'tecnologia-e-ia',
    description: 'Automatización del back office, inteligencia artificial y analítica contable.',
    color: 'purple',
    created_at: new Date('2026-09-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-09-01T00:00:00Z').toISOString(),
  },
]

// Artículos iniciales de semilla
const SEED_POSTS: BlogPost[] = [
  {
    id: 'f1a23456-789a-4bc0-9123-456789abcdef',
    title: 'Hablemos de finanzas y de lo que hace un gerente financiero',
    slug: 'hablemos-de-finanzas-y-gerente-financiero',
    excerpt: 'Conozca los 3 principios fundamentales de las finanzas corporativas, el cálculo del Valor Actual Neto (VAN) y cómo la IA está transformando el rol del gerente financiero hacia una visión estratégica.',
    category: 'Finanzas Corporativas',
    tags: ['Finanzas', 'VAN', 'Gerencia Financiera', 'Inversión', 'Estrategia'],
    author_name: 'Paola & Equipo Finto',
    author_role: 'Controller Financiero & Consultoría',
    reading_time_minutes: 6,
    published: true,
    featured: true,
    published_at: new Date('2026-09-20T10:00:00Z').toISOString(),
    created_at: new Date('2026-09-20T10:00:00Z').toISOString(),
    updated_at: new Date('2026-09-22T12:00:00Z').toISOString(),
    cover_image: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=1200&q=80',
    content: `Hablemos de finanzas y de lo que hace un gerente financiero.

Empecemos por los principios fundamentales de las finanzas:

1) **Un peso hoy vale más que un peso mañana.**
2) **A mayor rentabilidad, mayor riesgo, y viceversa.**
3) **La diversificación reduce el riesgo.**

Detengámonos aquí y revisemos qué hace un gerente financiero para comprender mejor estos principios fundamentales.

Un gerente financiero se encarga de proponer en qué activos debe invertir la empresa y cómo obtener los fondos para financiarlos.

Para determinar en qué activos debe invertir la empresa, el gerente financiero debe identificar inversiones con valor actual neto positivo.

El valor actual neto (VAN) es positivo cuando el valor actual (VA) es mayor que la inversión realizada:

> **Fórmula Fundamental:**
> **VAN = VA - Inversión realizada**

¿Cómo se calcula el valor actual (VA)? Se descuentan los pagos futuros esperados a la tasa de rentabilidad exigida por los inversionistas.

> **Valor actual (VA) = Factor de actualización × Valor futuro (VF)**

---

### Veamos un ejemplo práctico

Supongamos que la empresa evalúa comprar un terreno para construir un proyecto inmobiliario y venderlo dentro de un año. 

- **Inversión inicial:** $370.000 pesos
- **Valor estimado de venta en 1 año:** $420.000 pesos

De acuerdo con el primer principio financiero, **un peso hoy vale más que un peso mañana**, porque un peso disponible hoy puede invertirse en un activo de riesgo bajo o nulo, como un CDT, y generar intereses desde ese momento.

Entonces, ¿cuánto valen hoy los $420.000 pesos que se recibirán dentro de un año? Supongamos que hoy los CDT ofrecen una rentabilidad anual del **5%**.

Así, el valor actual (VA) de los $420.000 pesos que se recibirán dentro de un año es de **$400.000 pesos**:

$$VA = \\frac{1}{1 + 5\\%} \\times 420.000 = 400.000$$

Aquí debemos aplicar el **segundo principio de las finanzas**: *a mayor riesgo, mayor rentabilidad*. Los inversionistas preferirán un CDT si el proyecto inmobiliario también ofrece una rentabilidad del 5%, debido a sus riesgos de ejecución y comercialización, entre otros.

¿Qué rentabilidad debe ofrecer el proyecto? Debe ser superior a su **costo de oportunidad de capital**, es decir, a la rentabilidad que esperan los inversionistas por aplazar el pago en una alternativa con un nivel de riesgo equivalente al del proyecto.

Los inversionistas consideran que el proyecto inmobiliario es tan riesgoso como invertir en bolsa. Dado que la bolsa ofrece una rentabilidad del **12%**, solo invertirán en el proyecto inmobiliario si su rentabilidad es superior a ese porcentaje.

$$\\text{Rentabilidad} = \\frac{\\text{Beneficio}}{\\text{Inversión}} = \\frac{420.000 - 370.000}{370.000} = 13{,}5\\%$$

La misma conclusión se obtiene al calcular el **VAN**: es positivo en **$5.000 pesos** después de descontar los pagos futuros esperados a la tasa de rentabilidad exigida por los inversionistas, que en este caso es del 12%.

$$VA = \\frac{1}{1 + 12\\%} \\times 420.000 = 375.000$$
$$\\text{VAN} = VA - \\text{Inversión realizada}$$
$$\\text{VAN} = 375.000 - 370.000 = 5.000$$

**Dado que el proyecto crea riqueza (VAN > 0), vale la pena realizarlo.**

Finalmente, todo gerente financiero debe aplicar el **tercer principio fundamental de las finanzas**: *la diversificación reduce el riesgo*. Por esta razón, no debería invertir todos los recursos en un solo proyecto.

---

### La era de la Inteligencia Artificial en la Dirección Financiera

Según el **INCP**, la inteligencia artificial está llevando al gerente financiero de un papel centrado en el control y el reporte hacia otro más estratégico: 
- Integrar analítica avanzada
- Anticipar riesgos operativos y de mercado
- Orientar la creación continua de valor

Esto exige liderar la adopción tecnológica con foco en las personas, fortalecer el juicio profesional y desarrollar capacidades técnicas, digitales y éticas en los equipos de finanzas.`,
  },
  {
    id: 'f2b34567-890b-4cd1-9234-567890bcdef1',
    title: 'Control de Cartera y Flujo de Caja: Cómo acelerar el recaudo empresarial',
    slug: 'control-de-cartera-y-flujo-de-caja',
    excerpt: 'Estrategias probadas para disminuir los días promedio de cobro (DSO), automatizar recordatorios y blindar la liquidez operativa de su empresa.',
    category: 'Tesorería & Cartera',
    tags: ['Cartera', 'Flujo de Caja', 'Cobranza', 'Liquidez'],
    author_name: 'Equipo Finto',
    author_role: 'Especialistas en Cartera y Recaudo',
    reading_time_minutes: 4,
    published: true,
    featured: false,
    published_at: new Date('2026-09-15T09:00:00Z').toISOString(),
    created_at: new Date('2026-09-15T09:00:00Z').toISOString(),
    updated_at: new Date('2026-09-15T09:00:00Z').toISOString(),
    cover_image: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=1200&q=80',
    content: `El flujo de caja es el oxígeno de toda organización. Una empresa puede ser rentable en papel, pero si los clientes no pagan a tiempo, la operación se asfixia.

### 1. El Indicador Clave: Días de Venta Pendientes (DSO)
Calcular periódicamente su DSO le permite detectar desviaciones antes de que se conviertan en pérdidas:
$$\\text{DSO} = \\frac{\\text{Cuentas por Cobrar}}{\\text{Ventas Totales a Crédito}} \\times \\text{Días del Periodo}$$

### 2. Segmentación y Alertas Preventivas
No espere al vencimiento de la factura. Un proceso moderno de cartera contacta al cliente 5 días antes con el resumen del soporte y canales de pago habilitados.

### 3. Conciliación Diaria
Tener la información contable al día previene disputas y asegura que los estados de cuenta sean confiables.`,
  },
  {
    id: 'f3c45678-901c-4de2-9345-678901cdef12',
    title: 'Planeación Tributaria 2026: Anticipar obligaciones para maximizar rentabilidad',
    slug: 'planeacion-tributaria-2026',
    excerpt: 'Recomendaciones prácticas para estructurar el calendario de impuestos, retenciones y optimización de beneficios fiscales con total rigor legal.',
    category: 'Impuestos & Legal',
    tags: ['Tributaria', 'Impuestos', 'Contabilidad', 'DIAN'],
    author_name: 'Equipo Finto',
    author_role: 'Área Contable y Fiscal',
    reading_time_minutes: 5,
    published: true,
    featured: false,
    published_at: new Date('2026-09-10T14:30:00Z').toISOString(),
    created_at: new Date('2026-09-10T14:30:00Z').toISOString(),
    updated_at: new Date('2026-09-10T14:30:00Z').toISOString(),
    cover_image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1200&q=80',
    content: `Una planeación tributaria rigurosa no consiste en pagar menos indebidamente, sino en aprovechar todas las alternativas legales para no pagar un peso de más.

### Claves de la Planeación Fiscal
- **Cumplimiento sin sanciones:** Los intereses de mora y sanciones por extemporaneidad erosionan el margen neto de su negocio.
- **Soportes electrónicos:** Garantizar que cada costo y deducción cuente con su respectiva factura electrónica validada.
- **Auditoría preventiva mensual:** Conciliar retenciones en la fuente e IVA mes a mes para evitar sorpresas al cierre de año.`,
  },
]

// Estado en memoria
let inMemoryPosts: BlogPost[] = [...SEED_POSTS]
let inMemoryCategories: BlogCategory[] = [...SEED_CATEGORIES]
let hasAttemptedDbSeed = false

async function ensureDbSynced() {
  if (hasAttemptedDbSeed) return
  hasAttemptedDbSeed = true

  try {
    // 1. Sincronizar blog_posts si la tabla está vacía
    const { data: postsData, error: postsErr } = await supabase
      .from('blog_posts')
      .select('id')
      .limit(1)

    if (!postsErr && postsData && postsData.length === 0) {
      logger.info('Sembrando publicaciones iniciales en Supabase blog_posts...')
      await supabase.from('blog_posts').insert(SEED_POSTS)
    }

    // 2. Sincronizar blog_categories si la tabla existe y está vacía
    const { data: catData, error: catErr } = await supabase
      .from('blog_categories')
      .select('id')
      .limit(1)

    if (!catErr && catData && catData.length === 0) {
      logger.info('Sembrando categorías iniciales en Supabase blog_categories...')
      await supabase.from('blog_categories').insert(SEED_CATEGORIES)
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'No se pudo sincronizar automáticamente con Supabase')
  }
}

export const blogService = {
  // ── CATEGORÍAS ────────────────────────────────────────────────────────────

  /**
   * Obtener todas las categorías con el conteo de artículos asociados
   */
  async getCategories(): Promise<BlogCategory[]> {
    await ensureDbSynced()

    // Intentar leer de Supabase
    try {
      const { data, error } = await supabase
        .from('blog_categories')
        .select('*')
        .order('name', { ascending: true })

      if (!error && data && data.length > 0) {
        // Calcular post_count
        const categories = await Promise.all(
          data.map(async (cat) => {
            const { count } = await supabase
              .from('blog_posts')
              .select('id', { count: 'exact', head: true })
              .eq('category', cat.name)
            return {
              ...cat,
              post_count: count ?? 0,
            }
          })
        )
        return categories
      }
    } catch {
      // fallback en memoria
    }

    // Fallback en memoria
    return inMemoryCategories.map(cat => ({
      ...cat,
      post_count: inMemoryPosts.filter(
        p => p.category.trim().toLowerCase() === cat.name.trim().toLowerCase()
      ).length,
    }))
  },

  /**
   * Crear nueva categoría
   */
  async createCategory(input: CreateBlogCategoryInput): Promise<BlogCategory> {
    const slug = input.slug || input.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '')

    const now = new Date().toISOString()
    const newCat: BlogCategory = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      slug,
      description: input.description ?? '',
      color: input.color ?? 'brand',
      post_count: 0,
      created_at: now,
      updated_at: now,
    }

    try {
      const { data, error } = await supabase
        .from('blog_categories')
        .insert({
          id: newCat.id,
          name: newCat.name,
          slug: newCat.slug,
          description: newCat.description,
          color: newCat.color,
        })
        .select()
        .single()

      if (!error && data) {
        newCat.id = data.id
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Guardando categoría en memoria')
    }

    inMemoryCategories.push(newCat)
    return newCat
  },

  /**
   * Actualizar o renombrar categoría
   */
  async updateCategory(id: string, input: UpdateBlogCategoryInput): Promise<BlogCategory> {
    const current = inMemoryCategories.find(c => c.id === id)
    const oldName = current?.name

    const updates: any = { ...input, updated_at: new Date().toISOString() }
    if (input.name && !input.slug) {
      updates.slug = input.name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '')
    }

    try {
      const { data, error } = await supabase
        .from('blog_categories')
        .update(updates)
        .eq('id', id)
        .select()
        .single()

      if (!error && data) {
        // Si cambió el nombre, actualizar los artículos en BD
        if (input.name && oldName && input.name !== oldName) {
          await supabase
            .from('blog_posts')
            .update({ category: input.name })
            .eq('category', oldName)
        }
      }
    } catch {
      // fallback
    }

    // Actualizar en memoria
    const idx = inMemoryCategories.findIndex(c => c.id === id)
    if (idx !== -1) {
      inMemoryCategories[idx] = { ...inMemoryCategories[idx]!, ...updates }
    }

    // Si cambió de nombre, actualizar en memoria los artículos
    if (input.name && oldName && input.name !== oldName) {
      inMemoryPosts.forEach(p => {
        if (p.category === oldName) p.category = input.name!
      })
    }

    return inMemoryCategories[idx]!
  },

  /**
   * Eliminar categoría
   */
  async deleteCategory(id: string): Promise<boolean> {
    const target = inMemoryCategories.find(c => c.id === id)
    if (!target) return false

    try {
      await supabase.from('blog_categories').delete().eq('id', id)
    } catch {
      // fallback
    }

    inMemoryCategories = inMemoryCategories.filter(c => c.id !== id)
    return true
  },

  // ── ARTÍCULOS ─────────────────────────────────────────────────────────────

  /**
   * Obtener publicaciones públicas con filtros funcionales
   */
  async getPublicPosts(params: QueryBlogPostInput) {
    await ensureDbSynced()

    const isAllCategory = !params.category || params.category === 'all' || params.category === 'Todas'

    // Intentar consulta a Supabase
    try {
      let query = supabase
        .from('blog_posts')
        .select('*', { count: 'exact' })
        .eq('published', true)
        .order('featured', { ascending: false })
        .order('published_at', { ascending: false })

      if (!isAllCategory) {
        query = query.ilike('category', params.category!.trim())
      }
      if (params.featured) {
        query = query.eq('featured', params.featured === 'true')
      }
      if (params.search) {
        query = query.or(`title.ilike.%${params.search}%,excerpt.ilike.%${params.search}%,content.ilike.%${params.search}%`)
      }

      const from = (params.page - 1) * params.limit
      const to = from + params.limit - 1
      query = query.range(from, to)

      const { data, count, error } = await query
      if (!error && data && data.length > 0) {
        return { data, total: count ?? data.length, page: params.page, limit: params.limit }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Fallo al leer blog_posts de Supabase, usando memoria')
    }

    // Fallback robusto en memoria
    let posts = inMemoryPosts.filter(p => p.published)

    if (!isAllCategory) {
      const catToMatch = params.category!.trim().toLowerCase()
      posts = posts.filter(p => p.category.trim().toLowerCase() === catToMatch)
    }
    if (params.featured) {
      const isFeat = params.featured === 'true'
      posts = posts.filter(p => p.featured === isFeat)
    }
    if (params.search) {
      const q = params.search.toLowerCase()
      posts = posts.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.excerpt.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q)
      )
    }
    posts.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))

    const total = posts.length
    const from = (params.page - 1) * params.limit
    const data = posts.slice(from, from + params.limit)

    return { data, total, page: params.page, limit: params.limit }
  },

  /**
   * Obtener publicación por slug
   */
  async getPublicPostBySlug(slug: string): Promise<BlogPost | null> {
    await ensureDbSynced()

    try {
      const { data, error } = await supabase
        .from('blog_posts')
        .select('*')
        .eq('slug', slug)
        .eq('published', true)
        .single()

      if (!error && data) return data as BlogPost
    } catch {
      // fallback
    }

    const post = inMemoryPosts.find(p => p.slug === slug && p.published)
    return post ?? null
  },

  /**
   * Listar publicaciones para el panel administrativo con filtros
   */
  async getAdminPosts(params: QueryBlogPostInput) {
    await ensureDbSynced()

    const isAllCategory = !params.category || params.category === 'all' || params.category === 'Todas'

    try {
      let query = supabase
        .from('blog_posts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })

      if (params.published !== 'all') {
        query = query.eq('published', params.published === 'true')
      }
      if (!isAllCategory) {
        query = query.ilike('category', params.category!.trim())
      }
      if (params.search) {
        query = query.or(`title.ilike.%${params.search}%,excerpt.ilike.%${params.search}%`)
      }

      const from = (params.page - 1) * params.limit
      const to = from + params.limit - 1
      query = query.range(from, to)

      const { data, count, error } = await query
      if (!error && data && data.length > 0) {
        return { data, total: count ?? data.length, page: params.page, limit: params.limit }
      }
    } catch {
      // fallback
    }

    let posts = [...inMemoryPosts]
    if (params.published !== 'all') {
      const isPub = params.published === 'true'
      posts = posts.filter(p => p.published === isPub)
    }
    if (!isAllCategory) {
      const catToMatch = params.category!.trim().toLowerCase()
      posts = posts.filter(p => p.category.trim().toLowerCase() === catToMatch)
    }
    if (params.search) {
      const q = params.search.toLowerCase()
      posts = posts.filter(p => p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q))
    }

    const total = posts.length
    const from = (params.page - 1) * params.limit
    const data = posts.slice(from, from + params.limit)

    return { data, total, page: params.page, limit: params.limit }
  },

  /**
   * Crear nueva publicación
   */
  async createPost(input: CreateBlogPostInput): Promise<BlogPost> {
    const now = new Date().toISOString()
    const newPost: BlogPost = {
      id: crypto.randomUUID(),
      title: input.title,
      slug: input.slug,
      excerpt: input.excerpt ?? '',
      content: input.content,
      cover_image: input.cover_image ?? '',
      category: input.category,
      tags: input.tags ?? [],
      author_name: input.author_name ?? 'Equipo Finto',
      author_role: input.author_role ?? 'Finanzas & Estrategia',
      reading_time_minutes: input.reading_time_minutes ?? 5,
      published: input.published ?? false,
      featured: input.featured ?? false,
      published_at: input.published ? now : null,
      created_at: now,
      updated_at: now,
    }

    try {
      const { data, error } = await supabase
        .from('blog_posts')
        .insert(newPost)
        .select()
        .single()

      if (!error && data) {
        newPost.id = data.id
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Guardando post en memoria')
    }

    inMemoryPosts.unshift(newPost)
    return newPost
  },

  /**
   * Actualizar publicación
   */
  async updatePost(id: string, input: UpdateBlogPostInput): Promise<BlogPost> {
    const now = new Date().toISOString()
    const updates: any = { ...input, updated_at: now }
    if (input.published === true) {
      updates.published_at = now
    }

    try {
      await supabase
        .from('blog_posts')
        .update(updates)
        .eq('id', id)
    } catch {
      // fallback
    }

    const index = inMemoryPosts.findIndex(p => p.id === id)
    if (index === -1) {
      throw new Error('Publicación no encontrada')
    }

    const updated: BlogPost = {
      ...inMemoryPosts[index]!,
      ...updates,
    }
    inMemoryPosts[index] = updated
    return updated
  },

  /**
   * Alternar estado de publicación
   */
  async togglePublish(id: string): Promise<BlogPost> {
    const current = inMemoryPosts.find(p => p.id === id)
    const nextStatus = current ? !current.published : true
    return this.updatePost(id, { published: nextStatus })
  },

  /**
   * Eliminar publicación
   */
  async deletePost(id: string): Promise<boolean> {
    try {
      await supabase.from('blog_posts').delete().eq('id', id)
    } catch {
      // fallback
    }

    const index = inMemoryPosts.findIndex(p => p.id === id)
    if (index !== -1) {
      inMemoryPosts.splice(index, 1)
      return true
    }
    return false
  },
}
