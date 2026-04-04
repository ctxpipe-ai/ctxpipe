def _private_helper():
    return 42


def public_entry():
    """Visible symbol for find_symbol / callee tests."""
    return _private_helper()
