-- Tabla para registrar todos los envíos de notificaciones
CREATE TABLE IF NOT EXISTS public.notification_logs (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  channel          text        NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  recipient        text        NOT NULL,
  template         text        NOT NULL,
  company_id       uuid        REFERENCES public.companies(id) ON DELETE SET NULL,
  status           text        NOT NULL DEFAULT 'sent'
                               CHECK (status IN ('sent', 'delivered', 'failed')),
  error            text,
  duration_ms      integer,
  zavu_message_id  text,
  delivered_at     timestamptz,
  metadata         jsonb,
  created_at       timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_notif_logs_company  ON public.notification_logs (company_id, created_at DESC);
CREATE INDEX idx_notif_logs_status   ON public.notification_logs (status, created_at DESC);
CREATE INDEX idx_notif_logs_template ON public.notification_logs (template, created_at DESC);
CREATE INDEX idx_notif_logs_zavu_id  ON public.notification_logs (zavu_message_id)
  WHERE zavu_message_id IS NOT NULL;

ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

-- Solo rs_admin y admin pueden leer (service_role bypassa RLS para escritura)
CREATE POLICY "notification_logs: rs_staff ve todos"
  ON public.notification_logs FOR SELECT
  USING (public.is_rs_staff());

COMMENT ON TABLE public.notification_logs IS
  'Registro de todas las notificaciones enviadas por el sistema vía Zavu.dev';
