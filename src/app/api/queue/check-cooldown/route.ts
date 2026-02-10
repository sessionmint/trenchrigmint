import { NextRequest, NextResponse } from 'next/server';

export async function POST(_request: NextRequest) {
  try {
    void _request;
    return NextResponse.json({
      inCooldown: false,
      message: 'Cooldown disabled'
    });
  } catch (error) {
    console.error('[Cooldown Check] Error:', error);
    return NextResponse.json(
      { error: 'Failed to check cooldown' },
      { status: 500 }
    );
  }
}
