// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BookView } from '../../src/components/calendar/BookView';
import { I18nProvider } from '../../src/i18n';
import * as registry from '../../src/providers/registry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BookView', () => {
  it('lets a guest pick a slot and confirm a booking', async () => {
    vi.spyOn(registry, 'fetchPublicBookingPage').mockResolvedValue({
      title: 'Intro',
      description: null,
      location: 'Meet',
      durationMinutes: 30,
      hostName: 'Ada',
      availability: {
        timezone: 'UTC',
        weekdays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
      },
    });
    vi.spyOn(registry, 'fetchPublicBookingSlots').mockResolvedValue({
      slots: [{ startsAt: '2026-09-14T15:00:00.000Z', endsAt: '2026-09-14T15:30:00.000Z' }],
    });
    const book = vi.spyOn(registry, 'createPublicBooking').mockResolvedValue({
      title: 'Intro',
      startsAt: '2026-09-14T15:00:00.000Z',
      endsAt: '2026-09-14T15:30:00.000Z',
      location: 'Meet',
      hostName: 'Ada',
      ics: 'BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR',
      googleUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE',
    });

    render(
      <I18nProvider initial="en">
        <BookView token="tok-1" />
      </I18nProvider>,
    );

    expect(await screen.findByText('Intro')).toBeInTheDocument();
    const slot = await screen.findByRole('button', { name: /11:00|3:00|15:00/ });
    fireEvent.click(slot);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Lin' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'lin@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('You are booked')).toBeInTheDocument();
    expect(book).toHaveBeenCalledWith('tok-1', {
      name: 'Lin',
      email: 'lin@example.com',
      startsAt: '2026-09-14T15:00:00.000Z',
    });
  });
});
