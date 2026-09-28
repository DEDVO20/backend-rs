import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { blogService } from './blog.service.js'
import {
  createBlogPostSchema,
  updateBlogPostSchema,
  queryBlogPostSchema,
  createBlogCategorySchema,
  updateBlogCategorySchema,
} from './blog.schema.js'

const app = new Hono()

// ── Rutas Públicas (Lectores y filtros en la web) ──────────────────────────

// GET /api/blog/categories — lista de categorías activas (público)
app.get('/categories', async (c) => {
  const categories = await blogService.getCategories()
  return c.json(categories)
})

// GET /api/blog/public — listar artículos publicados con filtros
app.get('/public', zValidator('query', queryBlogPostSchema), async (c) => {
  const query = c.req.valid('query')
  const result = await blogService.getPublicPosts(query)
  return c.json(result)
})

// GET /api/blog/public/:slug — leer artículo completo por slug
app.get('/public/:slug', async (c) => {
  const slug = c.req.param('slug')
  const post = await blogService.getPublicPostBySlug(slug)
  if (!post) {
    return c.json({ error: 'Artículo no encontrado' }, 404)
  }
  return c.json(post)
})

// ── Rutas Administrativas (Gestión desde el panel admin) ────────────────────

app.use('/*', authMiddleware)
app.use('/*', requireRole('admin', 'rs_admin', 'rs_staff'))

// Categorías CRUD administrativo
app.post('/categories', zValidator('json', createBlogCategorySchema), async (c) => {
  const body = c.req.valid('json')
  const category = await blogService.createCategory(body)
  return c.json(category, 201)
})

app.patch('/categories/:id', zValidator('json', updateBlogCategorySchema), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  try {
    const category = await blogService.updateCategory(id, body)
    return c.json(category)
  } catch (err: any) {
    return c.json({ error: err.message }, 404)
  }
})

app.delete('/categories/:id', async (c) => {
  const id = c.req.param('id')
  const success = await blogService.deleteCategory(id)
  if (!success) {
    return c.json({ error: 'Categoría no encontrada' }, 404)
  }
  return c.json({ success: true, message: 'Categoría eliminada' })
})

// Artículos CRUD administrativo
app.get('/', zValidator('query', queryBlogPostSchema), async (c) => {
  const query = c.req.valid('query')
  const result = await blogService.getAdminPosts(query)
  return c.json(result)
})

app.post('/', zValidator('json', createBlogPostSchema), async (c) => {
  const body = c.req.valid('json')
  const post = await blogService.createPost(body)
  return c.json(post, 201)
})

app.patch('/:id', zValidator('json', updateBlogPostSchema), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  try {
    const post = await blogService.updatePost(id, body)
    return c.json(post)
  } catch (err: any) {
    return c.json({ error: err.message }, 404)
  }
})

app.patch('/:id/toggle-publish', async (c) => {
  const id = c.req.param('id')
  try {
    const post = await blogService.togglePublish(id)
    return c.json(post)
  } catch (err: any) {
    return c.json({ error: err.message }, 404)
  }
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const success = await blogService.deletePost(id)
  if (!success) {
    return c.json({ error: 'Artículo no encontrado' }, 404)
  }
  return c.json({ success: true, message: 'Artículo eliminado correctamente' })
})

export const blogRoutes = app
