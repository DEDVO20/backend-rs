-- La porción de mandato del tercero también puede venir en la cuenta 28051001
-- ("Contrato de Mandato …" — honorarios que van 100% al tercero), además de la
-- 28150601. Se agrega a la config de cuentas (prefijos separados por "|") para
-- que el import la capture. Solo actualiza la fila que aún tenga el valor viejo.

update participation_account_settings
  set mandate_account = '28150601|28051001', updated_at = now()
  where id = 1 and mandate_account = '28150601';
