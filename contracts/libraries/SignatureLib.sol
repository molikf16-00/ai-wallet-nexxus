// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SignatureLib
/// @notice Small, dependency-free ECDSA helper supporting standard and compact signatures.
library SignatureLib {
    error InvalidSignatureLength(uint256 length);
    error InvalidSignatureS();
    error InvalidSignatureV(uint8 v);
    error InvalidSignature();

    bytes32 private constant _SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// @notice Recovers a signer from a digest using an EIP-191 personal-sign envelope.
    function recoverEthSigned(bytes32 digest, bytes memory signature) internal pure returns (address) {
        return recover(toEthSignedMessageHash(digest), signature);
    }

    /// @notice Recovers a signer from a raw digest using a 65-byte or EIP-2098 64-byte signature.
    function recover(bytes32 digest, bytes memory signature) internal pure returns (address signer) {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            if (v < 27) v += 27;
            if (v != 27 && v != 28) revert InvalidSignatureV(v);
            if (uint256(s) > uint256(_SECP256K1N_HALF)) revert InvalidSignatureS();
            signer = ecrecover(digest, v, r, s);
        } else if (signature.length == 64) {
            bytes32 r;
            bytes32 vs;
            assembly {
                r := mload(add(signature, 0x20))
                vs := mload(add(signature, 0x40))
            }
            uint8 v = uint8((uint256(vs) >> 255) + 27);
            bytes32 s = bytes32(uint256(vs) & type(uint256).max >> 1);
            if (uint256(s) > uint256(_SECP256K1N_HALF)) revert InvalidSignatureS();
            signer = ecrecover(digest, v, r, s);
        } else {
            revert InvalidSignatureLength(signature.length);
        }
        if (signer == address(0)) revert InvalidSignature();
    }

    /// @notice Computes the EIP-191 digest used by eth_sign and personal_sign.
    function toEthSignedMessageHash(bytes32 digest) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }
}
