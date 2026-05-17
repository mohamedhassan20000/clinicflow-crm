alter type public.appointment_status add value if not exists 'arrived' after 'confirmed';
alter type public.appointment_status add value if not exists 'in_session' after 'arrived';
